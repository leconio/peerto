import type { IceAddressSnapshot } from "../../services/peer";

export type NetworkEnvironmentState =
  | "probing"
  | "ready"
  | "limited"
  | "cached"
  | "unavailable"
  | "offline";

export function networkEnvironmentState(
  snapshot: IceAddressSnapshot | undefined,
  probing: boolean,
  online: boolean,
): NetworkEnvironmentState {
  if (!online) return "offline";
  if (probing) return "probing";
  if (
    snapshot?.freshness === "current" &&
    snapshot.addresses.length > 0
  ) {
    return "ready";
  }
  if (snapshot?.freshness === "cached") return "cached";
  if (
    snapshot?.hasHostCandidate ||
    snapshot?.hasMaskedLanCandidate
  ) {
    return "limited";
  }
  return "unavailable";
}
