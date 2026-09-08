import type { WsSessionInit } from "@peerto/protocol";
import { WebSocket } from "ws";
import type { AppConfig } from "../config/app-config";
import { createChallenge, hashToken, randomToken, safeTokenEqual, verifyChallenge, verifyDeviceIdentity } from "../security/device-auth";
import type { RoomRecord, RoomStore } from "../storage/room-store";
import type { ConnectedSocket, RuntimeRoom, RuntimeRoomMap } from "./runtime-room";
import { closeWithMessage, listenMessages, send } from "./socket-utils";
import { consumeRoom, markSignalingStable, releaseRuntime } from "./signaling-retention";

/** Recovery roles belong to authenticated sockets, never HTTP request order. */
export function createRecoveryCoordinator(
  store: RoomStore,
  rooms: RuntimeRoomMap,
  config: AppConfig,
  acceptMessage: (socket: WebSocket) => boolean,
) {
  let sequence = 0;
  const orders = new WeakMap<WebSocket, number>();

  return (socket: WebSocket, ip: string, roomKey: string, room: RoomRecord, init: WsSessionInit): void => {
    const token = init.connectionToken;
    const deviceId = init.deviceId;
    const peerId = init.peerDeviceId;
    const matchesPair = (deviceId === room.host.deviceId && peerId === room.peerDeviceId) ||
      (peerId === room.host.deviceId && deviceId === room.peerDeviceId);
    if (!token || !deviceId || !peerId || !matchesPair || !safeTokenEqual(token, room.hostTokenHash)) {
      closeWithMessage(socket, { type: "error", code: "INVALID_CODE_MEMBERSHIP", message: "配对成员凭证无效" });
      return;
    }
    const tokenHash = hashToken(token);
    const order = ++sequence;
    orders.set(socket, order);
    const challenge = createChallenge();
    const member: ConnectedSocket = { socket, ip, isAlive: true };
    const authTimer = setTimeout(() => closeWithMessage(socket, {
      type: "error", code: "DEVICE_PROOF_TIMEOUT", message: "设备验证超时",
    }), 10_000);
    authTimer.unref();
    socket.on("pong", () => { member.isAlive = true; });

    const ready = (runtime: RuntimeRoom) => send(runtime.host.socket, {
      type: "room_ready", code: room.code, expiresAt: runtime.expiresAt,
    });
    const pair = (runtime: RuntimeRoom) => {
      if (!runtime.guest?.device || !runtime.host.device) return;
      runtime.accepted = true;
      runtime.hostConnected = false;
      runtime.guestConnected = false;
      runtime.sessionId = randomToken();
      send(runtime.host.socket, {
        type: "peer_accepted", peer: runtime.guest.device, sessionId: runtime.sessionId,
        rendezvous: { code: room.code, token, role: "host" },
      });
      send(runtime.guest.socket, {
        type: "peer_accepted", peer: runtime.host.device, sessionId: runtime.sessionId,
        rendezvous: { code: room.code, token, role: "guest" },
      });
    };

    listenMessages(socket, acceptMessage, async message => {
      if (!member.device) {
        if (message.type !== "authenticate" || message.device.deviceId !== deviceId ||
            !verifyDeviceIdentity(message.device) ||
            !verifyChallenge(message.device, room.code, challenge, message.signature)) {
          closeWithMessage(socket, { type: "error", code: "DEVICE_PROOF_FAILED", message: "设备身份签名验证失败" });
          return;
        }
        const registry = await store.getCode(room.code, tokenHash);
        if (!registry?.members[deviceId] || !(await store.upsertCodeMember(
          room.code, tokenHash, { device: message.device, updatedAt: Date.now() },
          config.ROOM_TTL_SECONDS, config.MAX_CODE_MEMBERS,
        ))) {
          closeWithMessage(socket, { type: "error", code: "INVALID_CODE_MEMBERSHIP", message: "配对成员凭证无效" });
          return;
        }
        const currentRoom = await store.getRoom(room.code, roomKey);
        if (socket.readyState !== WebSocket.OPEN) return;
        if (currentRoom?.id !== room.id || room.expiresAt <= Date.now()) {
          closeWithMessage(socket, { type: "room_closed", reason: "expired" });
          return;
        }
        let runtime = rooms.get(roomKey);
        if (runtime && runtime.roomId !== room.id) {
          // An older consumed signaling lease must not displace this room.
          releaseRuntime(rooms, runtime);
          runtime = undefined;
        }
        if (runtime?.consumed) {
          closeWithMessage(socket, { type: "room_closed", reason: "invalid_code" });
          return;
        }
        const duplicate = runtime && [runtime.host, runtime.guest].find(item => item?.device?.deviceId === deviceId);
        if (duplicate && (orders.get(duplicate.socket) || 0) > order) {
          closeWithMessage(socket, { type: "room_closed", reason: "replaced" });
          return;
        }
        // No awaits below: membership assignment and both role notifications
        // are one atomic turn. Unproven sockets cannot replace a live member.
        member.device = message.device;
        clearTimeout(authTimer);
        if (!runtime) {
          const created: RuntimeRoom = {
            roomId: room.id, roomKey, tokenHash, host: member,
            guest: undefined, guestIp: undefined, accepted: false,
            hostAuthenticated: true, hostConnected: false, guestConnected: false,
            consumed: false, connectionToken: token, expiresAt: room.expiresAt,
            expiryTimer: setTimeout(() => {
              if (rooms.get(roomKey) !== created) return;
              send(created.host.socket, { type: "room_closed", reason: "expired" });
              if (created.guest) send(created.guest.socket, { type: "room_closed", reason: "expired" });
              releaseRuntime(rooms, created);
              void store.deleteRoom(room.code, roomKey, room.id);
            }, Math.max(1, room.expiresAt - Date.now())),
          };
          created.expiryTimer.unref();
          rooms.set(roomKey, created);
          ready(created);
          return;
        }
        if (duplicate === runtime.host) runtime.host = member;
        else { runtime.guest = member; runtime.guestIp = ip; }
        if (duplicate) closeWithMessage(duplicate.socket, { type: "room_closed", reason: "replaced" });
        if (runtime.guest) pair(runtime);
        else ready(runtime);
        return;
      }
      const runtime = rooms.get(roomKey);
      if (!runtime || runtime.roomId !== room.id || !runtime.accepted) return;
      const isHost = runtime.host === member;
      if (!isHost && runtime.guest !== member) return;
      if ((message.type === "signal" || message.type === "connected" || message.type === "signaling_stable") && message.sessionId !== runtime.sessionId) return;
      if (message.type === "signal") {
        const other = isHost ? runtime.guest : runtime.host;
        if (other) send(other.socket, message);
      } else if (message.type === "signaling_stable") {
        markSignalingStable(rooms, runtime, member);
      } else if (message.type === "connected" && !runtime.consumed) {
        if (isHost) runtime.hostConnected = true;
        else runtime.guestConnected = true;
        consumeRoom(store, rooms, room.code, runtime);
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      const runtime = rooms.get(roomKey);
      if (!runtime || runtime.roomId !== room.id || (runtime.host !== member && runtime.guest !== member)) return;
      if (runtime.consumed) { releaseRuntime(rooms, runtime); return; }
      const remaining = runtime.host === member ? runtime.guest : runtime.host;
      if (!remaining || remaining.socket.readyState !== WebSocket.OPEN) {
        releaseRuntime(rooms, runtime);
        // Keep the bounded joinable record: the next verified arrival can host.
        return;
      }
      runtime.host = remaining;
      runtime.guest = undefined;
      runtime.guestIp = undefined;
      runtime.accepted = false;
      runtime.hostConnected = false;
      runtime.guestConnected = false;
      delete runtime.sessionId;
      ready(runtime);
    });
    send(socket, { type: "challenge", challenge });
  };
}
