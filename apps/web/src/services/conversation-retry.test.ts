import { describe, expect, it } from "vitest";
import {
  conversationRetryAfterConnectionDrop,
  conversationRetryAfterNetworkReturn,
} from "./conversation-retry";

describe("conversation retry state", () => {
  it("starts retrying when the currently open peer drops unexpectedly", () => {
    expect(
      conversationRetryAfterConnectionDrop(undefined, {
        activePeerId: "peer-b",
        selectedPeerId: "peer-b",
        isKnownPeer: true,
        networkAvailable: true,
        now: 10_000,
      }),
    ).toEqual({
      peerId: "peer-b",
      attempt: 1,
      phase: "waiting",
      nextAttemptAt: 11_000,
    });
  });

  it("does not open a background conversation when another peer drops", () => {
    expect(
      conversationRetryAfterConnectionDrop(undefined, {
        activePeerId: "peer-b",
        selectedPeerId: "saved",
        isKnownPeer: true,
        networkAvailable: true,
        now: 10_000,
      }),
    ).toBeUndefined();
  });

  it("keeps a retry pending without a timer while the browser is offline", () => {
    expect(
      conversationRetryAfterConnectionDrop(
        {
          peerId: "peer-b",
          attempt: 3,
          phase: "registered",
        },
        {
          activePeerId: "peer-b",
          selectedPeerId: "peer-b",
          isKnownPeer: true,
          networkAvailable: false,
        },
      ),
    ).toEqual({
      peerId: "peer-b",
      attempt: 3,
      phase: "waiting",
    });
  });

  it("restarts a selected pending conversation as soon as the network returns", () => {
    expect(
      conversationRetryAfterNetworkReturn(
        {
          peerId: "peer-b",
          attempt: 3,
          phase: "waiting",
        },
        "peer-b",
      ),
    ).toEqual({
      peerId: "peer-b",
      attempt: 4,
      phase: "attempting",
    });
  });
});
