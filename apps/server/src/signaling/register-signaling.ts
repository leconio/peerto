import {
  type DeviceIdentity,
} from "@peerto/protocol";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { AppConfig } from "../config/app-config";
import {
  createChallenge,
  hashToken,
  safeTokenEqual,
  verifyChallenge,
  verifyDeviceIdentity,
} from "../security/device-auth";
import type {
  RoomRecord,
  RoomStore,
} from "../storage/room-store";
import { reconnectRoomKey } from "./room-key";
import type {
  ConnectedSocket,
  RuntimeRoom,
  RuntimeRoomMap,
} from "./runtime-room";
import {
  asString,
  closeSocket,
  closeWithMessage,
  listenMessages,
  receiveSessionInit,
  send,
} from "./socket-utils";
import { consumeRoom, markSignalingStable, releaseRuntime } from "./signaling-retention";
import { createRecoveryCoordinator } from "./recovery-coordinator";
import { RecoveryRegistrationError, registerRecovery } from "./register-recovery";

const RUNTIME_START_GRACE_MS = 5_000;

export interface SignalingRoutesOptions {
  config: AppConfig;
  store: RoomStore;
  runtimeRooms: RuntimeRoomMap;
}

export function registerSignalingRoutes(
  app: FastifyInstance,
  { config, store, runtimeRooms }: SignalingRoutesOptions,
): void {
  let hostSequence = 0;
  const hostOrders = new WeakMap<WebSocket, number>();
  const activeConnectionsByIp = new Map<string, number>();
  const activeSockets = new Set<WebSocket>();
  const messageRates = new WeakMap<
    WebSocket,
    { count: number; resetsAt: number }
  >();

  const releaseConnection = (ip: string): void => {
    const current = activeConnectionsByIp.get(ip) || 0;
    if (current <= 1) activeConnectionsByIp.delete(ip);
    else activeConnectionsByIp.set(ip, current - 1);
  };

  const acceptMessage = (socket: WebSocket): boolean => {
    const now = Date.now();
    const current = messageRates.get(socket);
    if (!current || current.resetsAt <= now) {
      messageRates.set(socket, {
        count: 1,
        resetsAt: now + 60_000,
      });
      return true;
    }
    current.count += 1;
    if (current.count <= config.MAX_WS_MESSAGES_PER_MINUTE) {
      return true;
    }
    closeWithMessage(socket, {
      type: "error",
      code: "RATE_LIMITED",
      message: "信令消息过于频繁，请稍后重试",
    });
    return false;
  };

  const coordinateRecovery = createRecoveryCoordinator(store, runtimeRooms, config, acceptMessage);

  const signalingHeartbeat = setInterval(() => {
    for (const runtime of runtimeRooms.values()) {
      checkSocketHeartbeat(runtime.host);
      if (runtime.guest) checkSocketHeartbeat(runtime.guest);
    }
  }, 25_000);
  signalingHeartbeat.unref();

  const endRoom = async (
    runtime: RuntimeRoom,
    code: string,
    reason: "expired" | "host_offline",
  ): Promise<void> => {
    const { roomKey } = runtime;
    if (runtimeRooms.get(roomKey) !== runtime) return;
    if (runtime.consumed) {
      // Never delete a newer rendezvous that reuses a consumed room key.
      releaseRuntime(runtimeRooms, runtime);
      return;
    }
    send(runtime.host.socket, { type: "room_closed", reason });
    if (runtime.guest) send(runtime.guest.socket, { type: "room_closed", reason });
    releaseRuntime(runtimeRooms, runtime);
    await store.deleteRoom(code, roomKey, runtime.roomId);
    const tokenHash = runtime.tokenHash;
    const codeRecord = tokenHash
      ? await store.getCode(code, tokenHash)
      : null;
    if (codeRecord && Object.keys(codeRecord.members).length < 2) {
      await store.deleteCode(code, tokenHash!);
    }
  };

  const waitForRuntime = async (
    roomKey: string,
  ): Promise<RuntimeRoom | undefined> => {
    const deadline = Date.now() + RUNTIME_START_GRACE_MS;
    let runtime = runtimeRooms.get(roomKey);
    while (
      (!runtime || !runtime.hostAuthenticated) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runtime = runtimeRooms.get(roomKey);
    }
    return runtime?.hostAuthenticated ? runtime : undefined;
  };

  const acceptRuntimeMember = async (
    code: string,
    room: RoomRecord,
    runtime: RuntimeRoom,
    guest: ConnectedSocket & { device: DeviceIdentity },
  ): Promise<void> => {
    if (runtime.accepted) return;
    const registered = await store.upsertCodeMember(
      code,
      runtime.tokenHash,
      {
        device: guest.device,
        updatedAt: Date.now(),
      },
      config.ROOM_TTL_SECONDS,
      config.MAX_CODE_MEMBERS,
    );
    if (runtimeRooms.get(runtime.roomKey) !== runtime || runtime.guest !== guest ||
        runtime.consumed || runtime.accepted || guest.socket.readyState !== WebSocket.OPEN ||
        runtime.host.socket.readyState !== WebSocket.OPEN) return;
    if (!registered) {
      runtime.guest = undefined;
      closeWithMessage(guest.socket, { type: "error", code: "CODE_MEMBER_LIMIT", message: "配对成员数量已达上限" });
      return;
    }
    runtime.accepted = true;
    runtime.hostConnected = false;
    runtime.guestConnected = false;
    runtime.guestIp = guest.ip;
    const hostDevice = runtime.host.device || room.host;
    send(runtime.host.socket, {
      type: "peer_accepted",
      peer: guest.device,
      rendezvous: {
        code,
        token: runtime.connectionToken,
        role: "host",
      },
    });
    send(guest.socket, {
      type: "peer_accepted",
      peer: hostDevice,
      rendezvous: {
        code,
        token: runtime.connectionToken,
        role: "guest",
      },
    });
  };

  app.get(
    "/ws",
    { websocket: true },
    async (socket, request) => {
      // Reserve before any await, including authentication and rate checks.
      if (activeSockets.size >= config.MAX_WS_CONNECTIONS) {
        socket.terminate();
        return;
      }
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
      const sessionInitPromise = receiveSessionInit(socket);
      const query = request.query as Record<string, unknown>;
      const role = asString(query.role);
      const code = asString(query.code);

      if (
        (role !== "host" && role !== "guest") ||
        !code ||
        !/^\d{6}$/.test(code)
      ) {
        closeWithMessage(socket, {
          type: "error",
          code: "INVALID_QUERY",
          message: "连接参数无效",
        });
        return;
      }
      const origin = request.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== request.headers.host) {
            closeWithMessage(socket, {
              type: "error",
              code: "INVALID_ORIGIN",
              message: "WebSocket 来源无效",
            });
            return;
          }
        } catch {
          closeWithMessage(socket, {
            type: "error",
            code: "INVALID_ORIGIN",
            message: "WebSocket 来源无效",
          });
          return;
        }
      }

      if (
        await store.isRateLimited(
          `ws:${request.ip}`,
          config.RATE_LIMIT_WS_PER_MINUTE,
          60,
        )
      ) {
        closeWithMessage(socket, {
          type: "error",
          code: "RATE_LIMITED",
          message: "连接过于频繁，请稍后重试",
        });
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) return;
      const activeConnections =
        activeConnectionsByIp.get(request.ip) || 0;
      if (activeConnections >= config.MAX_WS_CONNECTIONS_PER_IP) {
        closeWithMessage(socket, {
          type: "error",
          code: "CONNECTION_LIMIT",
          message: "此网络的活动连接数已达到上限",
        });
        return;
      }
      activeConnectionsByIp.set(request.ip, activeConnections + 1);
      let connectionReleased = false;
      socket.once("close", () => {
        if (connectionReleased) return;
        connectionReleased = true;
        releaseConnection(request.ip);
      });

      const sessionInit = await sessionInitPromise;
      if (!sessionInit) {
        closeWithMessage(socket, {
          type: "error",
          code: "INVALID_QUERY",
          message: "连接初始化参数无效",
        });
        return;
      }
      const suppliedConnectionToken = sessionInit.connectionToken;
      const suppliedDeviceId = sessionInit.deviceId;
      const suppliedPeerDeviceId = sessionInit.peerDeviceId;

      if (sessionInit.recoveryDevice) {
        if (!suppliedConnectionToken || !suppliedPeerDeviceId ||
            suppliedDeviceId !== sessionInit.recoveryDevice.deviceId) {
          closeWithMessage(socket, { type: "error", code: "INVALID_QUERY", message: "配对信息无效" });
          return;
        }
        try {
          const { roomKey, room } = await registerRecovery(store, config, {
            code, device: sessionInit.recoveryDevice, peerDeviceId: suppliedPeerDeviceId,
            connectionToken: suppliedConnectionToken,
          }, request.ip);
          if (socket.readyState === WebSocket.OPEN) coordinateRecovery(socket, request.ip, roomKey, room, sessionInit);
        } catch (error) {
          closeWithMessage(socket, { type: "error",
            code: error instanceof RecoveryRegistrationError ? error.code : "SIGNALING_UNAVAILABLE",
            message: error instanceof RecoveryRegistrationError ? error.message : "信令暂时不可用" });
        }
        return;
      }

      const namespacedRoomKey =
        suppliedConnectionToken &&
        suppliedDeviceId &&
        suppliedPeerDeviceId
          ? reconnectRoomKey(
              code,
              suppliedConnectionToken,
              suppliedDeviceId,
              suppliedPeerDeviceId,
            )
          : code;
      let roomKey = namespacedRoomKey;
      let room = await store.getRoom(code, roomKey);
      if (!room && suppliedConnectionToken) {
        roomKey = code;
        room = await store.getRoom(code);
      }
      if (!room || room.expiresAt <= Date.now()) {
        closeWithMessage(socket, {
          type: "room_closed",
          reason: room ? "expired" : "invalid_code",
        });
        if (room) await store.deleteRoom(code, roomKey, room.id);
        return;
      }

      if (room.resume) {
        coordinateRecovery(socket, request.ip, roomKey, room, sessionInit);
        return;
      }

      if (role === "host") {
        const token = sessionInit.token;
        const connectionToken = suppliedConnectionToken;
        if (!token || !safeTokenEqual(token, room.hostTokenHash)) {
          closeWithMessage(socket, {
            type: "error",
            code: "INVALID_HOST_TOKEN",
            message: "主机凭证无效",
          });
          return;
        }
        const connectionTokenHash = connectionToken
          ? hashToken(connectionToken)
          : "";
        const codeRecord = connectionToken
          ? await store.getCode(code, connectionTokenHash)
          : null;
        const runtimeConnectionToken = connectionToken;
        if (
          !codeRecord ||
          !runtimeConnectionToken ||
          !safeTokenEqual(
            runtimeConnectionToken,
            codeRecord.tokenHash,
          )
        ) {
          closeWithMessage(socket, {
            type: "error",
            code: "INVALID_CODE_MEMBERSHIP",
            message: "连接码成员凭证无效",
          });
          return;
        }
        // Source IP is rate-limited, not identity. The host must still prove
        // its device key below after presenting the room/member credential.

        const order = ++hostSequence;
        hostOrders.set(socket, order);
        // An unproven socket owns only its own authentication deadline.
        const expiryTimer = setTimeout(() => closeWithMessage(socket, {
          type: "error", code: "DEVICE_PROOF_TIMEOUT", message: "设备验证超时",
        }), Math.max(1, Math.min(10_000, room.expiresAt - Date.now())));
        expiryTimer.unref();
        const hostChallenge = createChallenge();
        const hostConnection: ConnectedSocket = {
          socket,
          ip: request.ip,
          isAlive: true,
          device: room.host,
        };
        socket.on("pong", () => {
          hostConnection.isAlive = true;
        });
        const runtime: RuntimeRoom = {
          roomId: room.id,
          roomKey,
          tokenHash: codeRecord.tokenHash,
          host: hostConnection,
          guest: undefined,
          guestIp: undefined,
          accepted: false,
          hostAuthenticated: false,
          hostConnected: false,
          guestConnected: false,
          consumed: false,
          connectionToken: runtimeConnectionToken,
          expiresAt: room.expiresAt,
          expiryTimer,
        };
        send(socket, {
          type: "challenge",
          challenge: hostChallenge,
        });

        listenMessages(socket, acceptMessage, async message => {
          if (message.type === "authenticate" && !runtime.hostAuthenticated) {
            if (
              message.device.deviceId !== room.host.deviceId ||
              !verifyDeviceIdentity(message.device) ||
              !verifyChallenge(
                message.device,
                code,
                hostChallenge,
                message.signature,
              )
            ) {
              closeWithMessage(socket, {
                type: "error",
                code: "DEVICE_PROOF_FAILED",
                message: "主机设备身份签名验证失败",
              });
              return;
            }
            const registered = await store.upsertCodeMember(
              code,
              runtime.tokenHash,
              {
                device: message.device,
                updatedAt: Date.now(),
              },
              config.ROOM_TTL_SECONDS,
              config.MAX_CODE_MEMBERS,
            );
            if (!registered) {
              closeWithMessage(socket, {
                type: "error",
                code: "CODE_MEMBER_LIMIT",
                message: "此配对凭证登记的设备数量已达到上限",
              });
              return;
            }
            const latestRoom = await store.getRoom(code, roomKey);
            if (socket.readyState !== WebSocket.OPEN) return;
            if (latestRoom?.id !== room.id || room.expiresAt <= Date.now()) {
              closeWithMessage(socket, { type: "room_closed", reason: "expired" });
              return;
            }
            const existing = runtimeRooms.get(roomKey);
            if (existing?.consumed || (existing && (hostOrders.get(existing.host.socket) || 0) > order)) {
              closeWithMessage(socket, { type: "room_closed", reason: "replaced" });
              return;
            }
            if (existing) {
              send(existing.host.socket, { type: "room_closed", reason: "replaced" });
              releaseRuntime(runtimeRooms, existing);
            }
            runtime.host.device = message.device;
            runtime.hostAuthenticated = true;
            clearTimeout(runtime.expiryTimer);
            runtime.expiryTimer = setTimeout(() => {
              void endRoom(runtime, code, "expired");
            }, Math.max(1, room.expiresAt - Date.now()));
            runtime.expiryTimer.unref();
            runtimeRooms.set(roomKey, runtime);
            send(socket, {
              type: "room_ready",
              code,
              expiresAt: room.expiresAt,
            });
            return;
          }

          if (!runtime.hostAuthenticated) {
            send(socket, {
              type: "error",
              code: "NOT_AUTHENTICATED",
              message: "主机设备尚未通过身份验证",
            });
            return;
          }

          const current = runtimeRooms.get(roomKey);
          if (current !== runtime || current.host.socket !== socket) return;
          if (
            current.consumed &&
            message.type !== "signal" &&
            message.type !== "signaling_stable" &&
            message.type !== "connected"
          ) return;

          if (message.type === "signaling_stable") {
            markSignalingStable(runtimeRooms, current, current.host);
          } else if (
            message.type === "accept_peer" &&
            current.guest?.device?.deviceId === message.deviceId
          ) {
            await acceptRuntimeMember(code, room, current, current.guest as ConnectedSocket & { device: DeviceIdentity });
          } else if (
            message.type === "reject_peer" &&
            current.guest?.device?.deviceId === message.deviceId
          ) {
            send(current.guest.socket, { type: "peer_rejected" });
            closeSocket(current.guest.socket);
            current.guest = undefined;
            current.accepted = false;
            current.hostConnected = false;
            current.guestConnected = false;
          } else if (
            message.type === "signal" &&
            current.accepted &&
            current.guest
          ) {
            send(current.guest.socket, message);
          } else if (
            message.type === "connected" &&
            current.accepted
          ) {
            current.hostConnected = true;
            consumeRoom(store, runtimeRooms, code, current);
          }
        });

        socket.on("close", () => {
        clearTimeout(runtime.expiryTimer);
        const current = runtimeRooms.get(roomKey);
        if (current?.host.socket === socket) {
          void endRoom(current, code, "host_offline");
        }
        });
        return;
      }

      const runtime = await waitForRuntime(roomKey);
      if (socket.readyState !== WebSocket.OPEN) return;
      if (
        !runtime || runtime.consumed ||
        runtime.host.socket.readyState !== WebSocket.OPEN
      ) {
        closeWithMessage(socket, {
        type: "room_closed",
        reason: "host_offline",
        });
        return;
      }

      const challenge = createChallenge();
      const authTimer = setTimeout(() => closeWithMessage(socket, {
        type: "error", code: "DEVICE_PROOF_TIMEOUT", message: "设备验证超时",
      }), Math.max(1, Math.min(10_000, room.expiresAt - Date.now())));
      authTimer.unref();
      const guest: ConnectedSocket = {
        socket,
        ip: request.ip,
        isAlive: true,
      };
      socket.on("pong", () => {
        guest.isAlive = true;
      });
      send(socket, { type: "challenge", challenge });

      listenMessages(socket, acceptMessage, async message => {
        const current = runtimeRooms.get(roomKey);
          if (current !== runtime || current.roomId !== room.id) return;

          if (message.type === "authenticate" && !guest.device) {
            if (current.consumed) {
              closeWithMessage(socket, { type: "room_closed", reason: "invalid_code" });
              return;
            }
            const device = message.device;
            const shareAuthorized =
              message.shareToken !== undefined &&
              safeTokenEqual(message.shareToken, room.shareTokenHash);
            const memberTokenHash = message.connectionToken
              ? hashToken(message.connectionToken)
              : "";
            const codeRecord = message.connectionToken
              ? await store.getCode(code, memberTokenHash)
              : null;
            if (runtimeRooms.get(roomKey) !== current || socket.readyState !== WebSocket.OPEN ||
                current.consumed || current.host.socket.readyState !== WebSocket.OPEN) {
              closeWithMessage(socket, { type: "room_closed", reason: "invalid_code" });
              return;
            }
            const memberAuthorized =
              message.connectionToken !== undefined &&
              codeRecord !== null &&
              safeTokenEqual(
                message.connectionToken,
                codeRecord.tokenHash,
              ) &&
              Boolean(codeRecord.members[device.deviceId]) &&
              Boolean(codeRecord.members[room.host.deviceId]);
            if (
              !verifyDeviceIdentity(device) ||
              !verifyChallenge(
                device,
                code,
                challenge,
                message.signature,
              )
            ) {
              closeWithMessage(socket, {
                type: "error",
                code: "DEVICE_PROOF_FAILED",
                message: "设备身份签名验证失败",
              });
              return;
            }
            if (message.shareToken !== undefined && !shareAuthorized) {
              closeWithMessage(socket, {
                type: "error",
                code: "INVALID_SHARE_TOKEN",
                message: "分享链接凭证无效或已失效",
              });
              return;
            }
            if (
              message.connectionToken !== undefined && !memberAuthorized
            ) {
              closeWithMessage(socket, {
                type: "error",
                code: "INVALID_CODE_MEMBERSHIP",
                message: "连接码成员凭证无效",
              });
              return;
            }
            if (
              current.guestIp && current.guestIp !== request.ip &&
              !memberAuthorized
            ) {
              closeWithMessage(socket, { type: "room_closed", reason: "ip_changed" });
              return;
            }

            if (current.accepted) {
              closeWithMessage(socket, { type: "error", code: "ROOM_OCCUPIED", message: "此连接码已在建立连接" });
              return;
            }
            if (current.guest) {
              send(current.guest.socket, {
                type: "room_closed",
                reason: "replaced",
              });
              closeSocket(current.guest.socket);
            }
            guest.device = device;
            clearTimeout(authTimer);
            current.guest = guest;
            current.accepted = false;
            current.hostConnected = false;
            current.guestConnected = false;

            if (shareAuthorized || memberAuthorized) {
              await acceptRuntimeMember(code, room, current, guest as ConnectedSocket & { device: DeviceIdentity });
            } else {
              send(current.host.socket, {
                type: "join_request",
                device,
              });
            }
            return;
          }

          if (!guest.device || current.guest?.socket !== socket) {
            send(socket, {
              type: "error",
              code: "NOT_AUTHENTICATED",
              message: "设备尚未通过身份验证",
            });
            return;
          }

          if (message.type === "signaling_stable") {
            markSignalingStable(runtimeRooms, current, guest);
          } else if (message.type === "signal" && current.accepted) {
            send(current.host.socket, message);
          } else if (
            message.type === "connected" &&
            current.accepted
          ) {
            current.guestConnected = true;
            consumeRoom(store, runtimeRooms, code, current);
          }
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        const current = runtimeRooms.get(roomKey);
        if (current?.guest?.socket === socket) {
          if (current.consumed) {
            releaseRuntime(runtimeRooms, current);
            return;
          }
          current.guest = undefined;
          current.accepted = false;
          current.hostConnected = false;
          current.guestConnected = false;
        }
      });
    },
  );

  app.addHook("onClose", async () => {
    clearInterval(signalingHeartbeat);
    for (const runtime of runtimeRooms.values()) {
      clearTimeout(runtime.expiryTimer);
      closeSocket(runtime.host.socket, 1001);
      if (runtime.guest) closeSocket(runtime.guest.socket, 1001);
    }
    runtimeRooms.clear();
  });
}

function checkSocketHeartbeat(connection: ConnectedSocket): void {
  if (connection.socket.readyState !== WebSocket.OPEN) return;
  if (!connection.isAlive) {
    connection.socket.terminate();
    return;
  }
  connection.isAlive = false;
  connection.socket.ping();
}
