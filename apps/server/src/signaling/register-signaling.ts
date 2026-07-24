import {
  clientWsMessageSchema,
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
  receiveSessionInit,
  send,
} from "./socket-utils";

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
  const activeConnectionsByIp = new Map<string, number>();
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

  const signalingHeartbeat = setInterval(() => {
    for (const runtime of runtimeRooms.values()) {
      checkSocketHeartbeat(runtime.host);
      if (runtime.guest) checkSocketHeartbeat(runtime.guest);
    }
  }, 25_000);
  signalingHeartbeat.unref();

  const endRoom = async (
    roomKey: string,
    code: string,
    reason: "expired" | "host_offline" | "ip_changed" | "replaced",
  ): Promise<void> => {
    const runtime = runtimeRooms.get(roomKey);
    if (runtime) {
      clearTimeout(runtime.expiryTimer);
      send(runtime.host.socket, { type: "room_closed", reason });
      if (runtime.guest) {
        send(runtime.guest.socket, { type: "room_closed", reason });
        closeSocket(runtime.guest.socket);
      }
      closeSocket(runtime.host.socket);
      runtimeRooms.delete(roomKey);
    }
    await store.deleteRoom(code, roomKey);
    const tokenHash = runtime?.tokenHash;
    const codeRecord = tokenHash
      ? await store.getCode(code, tokenHash)
      : null;
    if (codeRecord && Object.keys(codeRecord.members).length < 2) {
      await store.deleteCode(code, tokenHash!);
    }
  };

  const consumeRoom = (code: string, runtime: RuntimeRoom): void => {
    if (
      runtime.consumed ||
      !runtime.hostConnected ||
      !runtime.guestConnected
    ) {
      return;
    }
    runtime.consumed = true;
    clearTimeout(runtime.expiryTimer);
    void store.deleteRoom(code, runtime.roomKey);
    send(runtime.host.socket, { type: "room_consumed" });
    if (runtime.guest) {
      send(runtime.guest.socket, { type: "room_consumed" });
    }
    runtimeRooms.delete(runtime.roomKey);
    closeSocket(runtime.host.socket);
    if (runtime.guest) closeSocket(runtime.guest.socket);
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
  ): Promise<boolean> => {
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
    if (!registered) return false;
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
    return true;
  };

  app.get(
    "/ws",
    { websocket: true },
    async (socket, request) => {
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
        if (room) await store.deleteRoom(code, roomKey);
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
        const runtimeConnectionToken = room.resume
          ? token
          : connectionToken;
        if (
          !codeRecord ||
          !runtimeConnectionToken ||
          !safeTokenEqual(
            runtimeConnectionToken,
            codeRecord.tokenHash,
          ) ||
          (room.resume &&
            (!codeRecord.members[room.host.deviceId] ||
              suppliedDeviceId !== room.host.deviceId ||
              suppliedPeerDeviceId !== room.peerDeviceId))
        ) {
          closeWithMessage(socket, {
            type: "error",
            code: "INVALID_CODE_MEMBERSHIP",
            message: "连接码成员凭证无效",
          });
          return;
        }
        if (request.ip !== room.hostIp) {
          await store.deleteRoom(code, roomKey);
          closeWithMessage(socket, {
            type: "room_closed",
            reason: "ip_changed",
          });
          return;
        }

        const existing = runtimeRooms.get(roomKey);
        if (existing) {
          clearTimeout(existing.expiryTimer);
          send(existing.host.socket, {
            type: "room_closed",
            reason: "replaced",
          });
          closeSocket(existing.host.socket);
          if (existing.guest) closeSocket(existing.guest.socket);
        }

        const expiryTimer = setTimeout(() => {
          void endRoom(roomKey, code, "expired");
        }, Math.max(1, room.expiresAt - Date.now()));
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
        runtimeRooms.set(roomKey, runtime);
        send(socket, {
          type: "challenge",
          challenge: hostChallenge,
        });

        socket.on("message", (raw) => {
          void (async () => {
            if (!acceptMessage(socket)) return;
            let json: unknown;
            try {
              json = JSON.parse(raw.toString());
            } catch {
              send(socket, {
                type: "error",
                code: "INVALID_JSON",
                message: "信令消息不是有效 JSON",
              });
              return;
            }
            const parsed = clientWsMessageSchema.safeParse(json);
            if (!parsed.success) {
              send(socket, {
                type: "error",
                code: "INVALID_MESSAGE",
                message: "信令消息格式无效",
              });
              return;
            }
            const current = runtimeRooms.get(roomKey);
            if (!current || current.host.socket !== socket) return;
            const message = parsed.data;

            if (
              message.type === "authenticate" &&
              !current.hostAuthenticated
            ) {
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
              current.host.device = message.device;
              current.hostAuthenticated = true;
              const registered = await store.upsertCodeMember(
                code,
                current.tokenHash,
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
              send(socket, {
                type: "room_ready",
                code,
                expiresAt: room.expiresAt,
              });
              return;
            }

            if (!current.hostAuthenticated) {
              send(socket, {
                type: "error",
                code: "NOT_AUTHENTICATED",
                message: "主机设备尚未通过身份验证",
              });
              return;
            }

            if (
              message.type === "accept_peer" &&
              current.guest?.device?.deviceId === message.deviceId
            ) {
              current.accepted = true;
              current.hostConnected = false;
              current.guestConnected = false;
              current.guestIp = current.guest.ip;
              const registered = await acceptRuntimeMember(
                code,
                room,
                current,
                current.guest as ConnectedSocket & {
                  device: DeviceIdentity;
                },
              );
              if (!registered) {
                current.accepted = false;
                closeWithMessage(current.guest.socket, {
                  type: "error",
                  code: "CODE_MEMBER_LIMIT",
                  message: "此配对凭证登记的设备数量已达到上限",
                });
                current.guest = undefined;
              }
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
              consumeRoom(code, current);
            }
          })();
        });

        socket.on("close", () => {
          const current = runtimeRooms.get(roomKey);
          if (current?.host.socket === socket) {
            void endRoom(roomKey, code, "host_offline");
          }
        });
        return;
      }

      const runtime = await waitForRuntime(roomKey);
      if (!runtime || runtime.host.socket.readyState !== WebSocket.OPEN) {
        closeWithMessage(socket, {
          type: "room_closed",
          reason: "host_offline",
        });
        return;
      }

      const challenge = createChallenge();
      const guest: ConnectedSocket = {
        socket,
        ip: request.ip,
        isAlive: true,
      };
      socket.on("pong", () => {
        guest.isAlive = true;
      });
      send(socket, { type: "challenge", challenge });

      socket.on("message", (raw) => {
        void (async () => {
          if (!acceptMessage(socket)) return;
          let json: unknown;
          try {
            json = JSON.parse(raw.toString());
          } catch {
            send(socket, {
              type: "error",
              code: "INVALID_JSON",
              message: "信令消息不是有效 JSON",
            });
            return;
          }
          const parsed = clientWsMessageSchema.safeParse(json);
          if (!parsed.success) {
            send(socket, {
              type: "error",
              code: "INVALID_MESSAGE",
              message: "信令消息格式无效",
            });
            return;
          }
          const current = runtimeRooms.get(roomKey);
          if (!current) return;
          const message = parsed.data;

          if (message.type === "authenticate" && !guest.device) {
            const device = message.device;
            const shareAuthorized =
              !room.resume &&
              message.shareToken !== undefined &&
              safeTokenEqual(message.shareToken, room.shareTokenHash);
            const memberTokenHash = message.connectionToken
              ? hashToken(message.connectionToken)
              : "";
            const codeRecord = message.connectionToken
              ? await store.getCode(code, memberTokenHash)
              : null;
            const memberAuthorized =
              message.connectionToken !== undefined &&
              codeRecord !== null &&
              safeTokenEqual(
                message.connectionToken,
                codeRecord.tokenHash,
              ) &&
              Boolean(codeRecord.members[device.deviceId]) &&
              Boolean(codeRecord.members[room.host.deviceId]) &&
              (!room.resume ||
                (device.deviceId === room.peerDeviceId &&
                  suppliedDeviceId === device.deviceId &&
                  suppliedPeerDeviceId === room.host.deviceId));
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
              (message.connectionToken !== undefined &&
                !memberAuthorized) ||
              (room.resume && !memberAuthorized)
            ) {
              closeWithMessage(socket, {
                type: "error",
                code: "INVALID_CODE_MEMBERSHIP",
                message: "连接码成员凭证无效",
              });
              return;
            }
            if (current.guestIp && current.guestIp !== request.ip) {
              void endRoom(roomKey, code, "ip_changed");
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
            current.guest = guest;
            current.accepted = false;
            current.hostConnected = false;
            current.guestConnected = false;

            if (shareAuthorized || memberAuthorized) {
              current.accepted = true;
              current.guestIp = guest.ip;
              const registered = await acceptRuntimeMember(
                code,
                room,
                current,
                guest as ConnectedSocket & { device: DeviceIdentity },
              );
              if (!registered) {
                current.accepted = false;
                closeWithMessage(guest.socket, {
                  type: "error",
                  code: "CODE_MEMBER_LIMIT",
                  message: "此配对凭证登记的设备数量已达到上限",
                });
                current.guest = undefined;
              }
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

          if (message.type === "signal" && current.accepted) {
            send(current.host.socket, message);
          } else if (
            message.type === "connected" &&
            current.accepted
          ) {
            current.guestConnected = true;
            consumeRoom(code, current);
          }
        })();
      });

      socket.on("close", () => {
        const current = runtimeRooms.get(roomKey);
        if (current?.guest?.socket === socket) {
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
