import { describe, expect, it } from "vitest";
import {
  APP_STATE_STORAGE_KEY,
  FIRST_DEVICE_NAME_STORAGE_KEY,
  loadFirstDeviceName,
  needsFirstDeviceName,
  normalizedDeviceName,
  saveFirstDeviceName,
} from "./first-use";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("first use device name", () => {
  it("requires a name only when there is no prior installation", () => {
    expect(needsFirstDeviceName(memoryStorage())).toBe(true);
    expect(
      needsFirstDeviceName(
        memoryStorage({ [APP_STATE_STORAGE_KEY]: "persisted" }),
      ),
    ).toBe(false);
    expect(
      needsFirstDeviceName(
        memoryStorage({ [FIRST_DEVICE_NAME_STORAGE_KEY]: "Desk" }),
      ),
    ).toBe(false);
  });

  it("trims, stores, and reloads a valid name", () => {
    const storage = memoryStorage();
    expect(saveFirstDeviceName(storage, "  Work Mac  ")).toBe(
      "Work Mac",
    );
    expect(loadFirstDeviceName(storage)).toBe("Work Mac");
    expect(normalizedDeviceName("   ")).toBeUndefined();
  });

  it("limits names to the protocol maximum of 64 characters", () => {
    expect(normalizedDeviceName("a".repeat(70))).toHaveLength(64);
  });
});
