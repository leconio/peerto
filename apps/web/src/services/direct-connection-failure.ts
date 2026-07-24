import type { RuntimeCode } from "./peer/types";

export function directConnectionFailureCode(
  customPeerIp: string | undefined,
): RuntimeCode {
  return customPeerIp
    ? "customIpConnectionFailed"
    : "directConnectionFailed";
}
