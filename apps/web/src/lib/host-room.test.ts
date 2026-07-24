import { describe, expect, it } from "vitest";
import { canReuseHostRoom } from "./host-room";

describe("host room reuse", () => {
  const room = {
    code: "123456",
    expiresAt: 20_000,
  };

  it("reuses an active, unused room before it expires", () => {
    expect(canReuseHostRoom(room, "123456", 10_000)).toBe(true);
  });

  it("does not reuse a room after it expires", () => {
    expect(canReuseHostRoom(room, "123456", 20_000)).toBe(false);
  });

  it("does not reuse a room that is no longer actively hosted", () => {
    expect(canReuseHostRoom(room, undefined, 10_000)).toBe(false);
    expect(canReuseHostRoom(room, "654321", 10_000)).toBe(false);
  });
});
