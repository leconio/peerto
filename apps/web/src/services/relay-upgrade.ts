import type { ConnectionRoute } from "../lib/network";

const RELAY_UPGRADE_DELAYS_MS = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;

export function relayUpgradeDelay(attempts: number): number {
  const index = Math.min(
    Math.max(0, Math.trunc(attempts)),
    RELAY_UPGRADE_DELAYS_MS.length - 1,
  );
  return RELAY_UPGRADE_DELAYS_MS[index]!;
}

export function hasTurnServer(iceServers: RTCIceServer[]): boolean {
  return iceServers.some((server) => {
    const urls =
      typeof server.urls === "string" ? [server.urls] : server.urls;
    return urls.some((url) => /^turns?:/i.test(url.trim()));
  });
}

export interface RelayUpgradeState {
  role: "host" | "guest" | undefined;
  online: boolean;
  relayOnly: boolean;
  route?: ConnectionRoute;
  iceServers: RTCIceServer[];
}

export function shouldScheduleRelayUpgrade(
  state: RelayUpgradeState,
): boolean {
  return (
    state.role === "host" &&
    state.online &&
    !state.relayOnly &&
    state.route?.kind === "relay" &&
    hasTurnServer(state.iceServers)
  );
}
