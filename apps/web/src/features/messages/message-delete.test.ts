import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../store";
import { canPeerDeleteMessage } from "./message-delete";

function message(
  conversationId: string,
  senderId: string,
): StoredMessage {
  return {
    id: crypto.randomUUID(),
    conversationId,
    senderId,
    kind: "text",
    text: "message",
    createdAt: Date.now(),
    status: "delivered",
  };
}

describe("canPeerDeleteMessage", () => {
  it("allows the peer to delete only its own conversation message", () => {
    expect(
      canPeerDeleteMessage(message("peer-a", "peer-a"), "peer-a"),
    ).toBe(true);
    expect(
      canPeerDeleteMessage(message("peer-a", "self"), "peer-a"),
    ).toBe(false);
    expect(
      canPeerDeleteMessage(message("peer-b", "peer-a"), "peer-a"),
    ).toBe(false);
  });

  it("treats an already missing message as deleted", () => {
    expect(canPeerDeleteMessage(undefined, "peer-a")).toBe(true);
  });
});
