import { hashToken } from "../security/device-auth";

export function reconnectRoomKey(
  code: string,
  connectionToken: string,
  leftDeviceId: string,
  rightDeviceId: string,
): string {
  const devices = [leftDeviceId, rightDeviceId].sort();
  return `${code}:${hashToken(connectionToken)}:${devices[0]}:${devices[1]}`;
}
