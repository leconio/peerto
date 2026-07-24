import { describe, expect, it } from "vitest";
import { parseCachedIceAddresses } from "./ice-address-cache";

describe("parseCachedIceAddresses", () => {
  const now = Date.UTC(2026, 6, 23);

  it("keeps unique public and LAN IP addresses", () => {
    expect(
      parseCachedIceAddresses(
        JSON.stringify({
          addresses: [
            "192.168.1.20",
            "203.0.113.8",
            "192.168.1.20",
            "device.local",
          ],
          savedAt: now - 1_000,
        }),
        now,
      ),
    ).toEqual(["192.168.1.20", "203.0.113.8"]);
  });

  it("rejects expired, future, and malformed cache records", () => {
    expect(
      parseCachedIceAddresses(
        JSON.stringify({
          addresses: ["192.168.1.20"],
          savedAt: now - 31 * 24 * 60 * 60 * 1_000,
        }),
        now,
      ),
    ).toEqual([]);
    expect(
      parseCachedIceAddresses(
        JSON.stringify({
          addresses: ["192.168.1.20"],
          savedAt: now + 1,
        }),
        now,
      ),
    ).toEqual([]);
    expect(parseCachedIceAddresses("not-json", now)).toEqual([]);
  });
});
