import { describe, expect, it } from "vitest";
import {
  reconnectBackoffDelayMs,
  RECONNECT_MAX_DELAY_MS,
} from "./reconnect-backoff";

describe("reconnectBackoffDelayMs", () => {
  it("backs off exponentially and caps at thirty seconds", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7].map(reconnectBackoffDelayMs),
    ).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_MAX_DELAY_MS,
    ]);
  });

  it("normalizes invalid attempt counts to the first retry", () => {
    expect(reconnectBackoffDelayMs(0)).toBe(1_000);
    expect(reconnectBackoffDelayMs(-4)).toBe(1_000);
  });
});
