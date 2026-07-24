import { describe, expect, it } from "vitest";
import {
  InMemoryRoomStore,
  type CodeRecord,
  type RoomRecord,
} from "./room-store";

const device = {
  deviceId: "device-id-with-at-least-twenty-characters",
  name: "Test Device",
  publicKey: {
    crv: "P-256" as const,
    kty: "EC" as const,
    x: "x",
    y: "y",
  },
};

function room(code = "123456"): RoomRecord {
  return {
    code,
    host: device,
    hostIp: "127.0.0.1",
    hostTokenHash: "host-token-hash",
    shareTokenHash: "share-token-hash",
    resume: false,
    createdAt: 1,
    expiresAt: 60_000,
  };
}

function codeRecord(code = "123456"): CodeRecord {
  return {
    code,
    tokenHash: "connection-token-hash",
    members: {
      [device.deviceId]: {
        device,
        updatedAt: 1,
      },
    },
    createdAt: 1,
  };
}

function createStore(now: () => number, overrides = {}) {
  return new InMemoryRoomStore({
    maxRooms: 2,
    maxCodes: 2,
    maxRateBuckets: 2,
    cleanupIntervalMs: 60_000,
    now,
    ...overrides,
  });
}

describe("InMemoryRoomStore", () => {
  it("expires rooms, code registries, and rate buckets by TTL", async () => {
    let clock = 1_000;
    const store = createStore(() => clock);

    try {
      expect(await store.createRoom(room(), 1)).toBe(true);
      expect(await store.createCode(codeRecord(), 1)).toBe(true);
      expect(await store.isRateLimited("ip", 1, 1)).toBe(false);
      expect(store.stats()).toEqual({
        rooms: 1,
        codes: 1,
        rateBuckets: 1,
      });

      clock = 2_001;
      expect(await store.getRoom("123456")).toBeNull();
      expect(
        await store.getCode("123456", "connection-token-hash"),
      ).toBeNull();
      expect(await store.isRateLimited("ip", 1, 1)).toBe(false);
      expect(store.stats()).toEqual({
        rooms: 0,
        codes: 0,
        rateBuckets: 1,
      });
    } finally {
      store.close();
    }
  });

  it("refreshes code TTL while enforcing the member limit", async () => {
    let clock = 1_000;
    const store = createStore(() => clock);
    const record = codeRecord();

    try {
      await store.createCode(record, 1);
      const secondDevice = {
        ...device,
        deviceId: "second-device-id-with-twenty-characters",
        name: "Second",
      };
      expect(
        await store.upsertCodeMember(
          record.code,
          record.tokenHash,
          { device: secondDevice, updatedAt: clock },
          2,
          2,
        ),
      ).toBe(true);
      expect(
        await store.upsertCodeMember(
          record.code,
          record.tokenHash,
          {
            device: {
              ...device,
              deviceId: "third-device-id-with-twenty-characters",
            },
            updatedAt: clock,
          },
          2,
          2,
        ),
      ).toBe(false);

      clock = 2_500;
      expect(
        await store.getCode(record.code, record.tokenHash),
      ).not.toBeNull();
      clock = 3_001;
      expect(
        await store.getCode(record.code, record.tokenHash),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  it("fails closed when each bounded map reaches capacity", async () => {
    const store = createStore(() => 1_000, {
      maxRooms: 1,
      maxCodes: 1,
      maxRateBuckets: 1,
    });

    try {
      expect(await store.createRoom(room("111111"), 60)).toBe(true);
      expect(await store.createRoom(room("222222"), 60)).toBe(false);
      expect(await store.createCode(codeRecord("111111"), 60)).toBe(
        true,
      );
      expect(await store.createCode(codeRecord("222222"), 60)).toBe(
        false,
      );
      expect(await store.isRateLimited("first", 10, 60)).toBe(false);
      expect(await store.isRateLimited("second", 10, 60)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("replaces a room only when the observed generation still matches", async () => {
    const store = createStore(() => 1_000);
    const original = room();

    try {
      await store.createRoom(original, 60);
      expect(
        await store.replaceRoom(
          { ...original, createdAt: 2 },
          60,
          99,
        ),
      ).toBe(false);
      expect(
        await store.replaceRoom(
          { ...original, createdAt: 2 },
          60,
          original.createdAt,
        ),
      ).toBe(true);
      expect((await store.getRoom(original.code))?.createdAt).toBe(2);
    } finally {
      store.close();
    }
  });
});
