import { describe, expect, it } from "vitest";
import {
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

});
