import { describe, expect, it } from "vitest";
import {
  retryCanBeUpdatedByPeer,
  shouldOpenPeerConversation,
} from "./peer-session-scope";

describe("multi-peer session scope", () => {
  it("keeps a background peer recovery from changing the open conversation", () => {
    expect(
      shouldOpenPeerConversation(false, "peer-b", "peer-a"),
    ).toBe(false);
    expect(
      shouldOpenPeerConversation(false, "peer-b", "peer-b"),
    ).toBe(true);
    expect(
      shouldOpenPeerConversation(true, "saved", "peer-a"),
    ).toBe(true);
  });

  it("keeps one peer from changing another peer's retry", () => {
    const retry = {
      peerId: "peer-b",
      attempt: 2,
      phase: "attempting" as const,
    };
    expect(retryCanBeUpdatedByPeer(retry, "peer-a")).toBe(false);
    expect(retryCanBeUpdatedByPeer(retry, "peer-b")).toBe(true);
  });
});
