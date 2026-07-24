import { reconnectBackoffDelayMs } from "./reconnect-backoff";

export interface ConversationRetryState {
  peerId: string;
  attempt: number;
  phase: "attempting" | "registered" | "waiting";
  nextAttemptAt?: number;
}

interface ConnectionDropContext {
  activePeerId: string | undefined;
  selectedPeerId: string;
  isKnownPeer: boolean;
  networkAvailable: boolean;
  now?: number;
}

export function conversationRetryAfterConnectionDrop(
  current: ConversationRetryState | undefined,
  context: ConnectionDropContext,
): ConversationRetryState | undefined {
  if (
    current?.phase === "attempting" ||
    current?.phase === "registered"
  ) {
    return {
      peerId: current.peerId,
      attempt: current.attempt,
      phase: "waiting",
      ...(context.networkAvailable
        ? {
            nextAttemptAt:
              (context.now ?? Date.now()) +
              reconnectBackoffDelayMs(current.attempt),
          }
        : {}),
    };
  }

  const activePeerId = context.activePeerId;
  if (
    !current &&
    activePeerId !== undefined &&
    context.selectedPeerId === activePeerId &&
    context.isKnownPeer
  ) {
    return {
      peerId: activePeerId,
      attempt: 1,
      phase: "waiting",
      ...(context.networkAvailable
        ? {
            nextAttemptAt:
              (context.now ?? Date.now()) +
              reconnectBackoffDelayMs(1),
          }
        : {}),
    };
  }

  return current;
}

export function conversationRetryAfterNetworkReturn(
  current: ConversationRetryState | undefined,
  selectedPeerId: string,
): ConversationRetryState | undefined {
  if (
    !current ||
    current.phase !== "waiting" ||
    current.peerId !== selectedPeerId
  ) {
    return current;
  }

  return {
    peerId: current.peerId,
    attempt: current.attempt + 1,
    phase: "attempting",
  };
}
