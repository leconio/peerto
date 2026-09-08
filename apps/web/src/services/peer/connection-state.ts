import type { ConnectionStatus } from "./types";

// Terminal states never start another rendezvous. Only a user action may
// leave them; transient ICE recovery stays in `reconnecting`.
export function connectionIsBusy(status: ConnectionStatus): boolean {
  return status === "signaling" || status === "waiting" ||
    status === "authenticating" || status === "connecting" ||
    status === "reconnecting";
}
