import type { ReconnectRoomRequest } from "@peerto/protocol";
import type { AppConfig } from "../config/app-config";
import { hashToken, randomToken, verifyDeviceIdentity } from "../security/device-auth";
import type { RoomRecord, RoomStore } from "../storage/room-store";
import { reconnectRoomKey } from "./room-key";

export class RecoveryRegistrationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/** Shared by WS registration and the compatibility REST endpoint. */
export async function registerRecovery(
  store: RoomStore, config: AppConfig, input: ReconnectRoomRequest, ip: string,
): Promise<{ roomKey: string; room: RoomRecord }> {
  const { code, device, peerDeviceId, connectionToken } = input;
  if (await store.isRateLimited(`reconnect:${ip}`, config.RATE_LIMIT_RECONNECT_PER_MINUTE, 60)) {
    throw new RecoveryRegistrationError("RATE_LIMITED", 429, "重新连接过于频繁，请稍后重试");
  }
  if (!verifyDeviceIdentity(device) || device.deviceId === peerDeviceId) {
    throw new RecoveryRegistrationError("INVALID_DEVICE", 400, "设备身份校验失败");
  }
  if (await store.isRateLimited(`reconnect-device:${device.deviceId}`, config.RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE, 60)) {
    throw new RecoveryRegistrationError("RATE_LIMITED", 429, "此设备重新连接过于频繁，请稍后重试");
  }
  const tokenHash = hashToken(connectionToken);
  const member = { device, updatedAt: Date.now() };
  if (!(await store.getCode(code, tokenHash))) {
    await store.createCode({ code, tokenHash, members: { [device.deviceId]: member }, createdAt: Date.now() }, config.ROOM_TTL_SECONDS);
  }
  if (!(await store.upsertCodeMember(code, tokenHash, member, config.ROOM_TTL_SECONDS, config.MAX_CODE_MEMBERS))) {
    throw new RecoveryRegistrationError("CODE_MEMBER_LIMIT", 409, "此配对凭证登记的设备数量已达到上限");
  }
  const roomKey = reconnectRoomKey(code, connectionToken, device.deviceId, peerDeviceId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await store.getRoom(code, roomKey);
    if (existing && existing.expiresAt > Date.now()) return { roomKey, room: existing };
    if (existing) await store.deleteRoom(code, roomKey, existing.id);
    const createdAt = Date.now();
    const room: RoomRecord = {
      id: randomToken(), code, host: device, hostTokenHash: tokenHash, shareTokenHash: tokenHash,
      resume: true, peerDeviceId, createdAt, expiresAt: createdAt + config.ROOM_TTL_SECONDS * 1_000,
    };
    if (await store.createRoom(room, config.ROOM_TTL_SECONDS, roomKey)) return { roomKey, room };
  }
  throw new RecoveryRegistrationError("ROOM_UNAVAILABLE", 503, "暂时无法建立会合，请稍后重试");
}
