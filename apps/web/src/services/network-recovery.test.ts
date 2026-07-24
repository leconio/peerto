import { describe, expect, it } from "vitest";
import { canRestoreExistingPeerConnection } from "./network-recovery";

describe("canRestoreExistingPeerConnection", () => {
  it("restores online state only while both WebRTC layers remain connected", () => {
    expect(
      canRestoreExistingPeerConnection("open", "connected"),
    ).toBe(true);
    expect(
      canRestoreExistingPeerConnection("open", "disconnected"),
    ).toBe(false);
    expect(
      canRestoreExistingPeerConnection("closed", "connected"),
    ).toBe(false);
  });
});
