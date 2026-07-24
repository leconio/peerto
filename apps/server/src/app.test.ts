import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { once } from "node:events";
import {
  stablePublicKey,
  type DeviceIdentity,
  type ServerWsMessage,
} from "@peerto/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { challengePayload } from "./security/device-auth";
import type { TurnstileVerifier } from "./security/turnstile";
import { buildApp } from "./app";
import type { AppConfig } from "./config/app-config";
import type {
  CodeMember,
  CodeRecord,
  RoomRecord,
  RoomStore,
} from "./storage/room-store";

class MemoryRoomStore implements RoomStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly codes = new Map<string, CodeRecord>();
  readonly rates = new Map<string, number>();

  async createRoom(
    room: RoomRecord,
    _ttlSeconds?: number,
    roomKey = room.code,
  ): Promise<boolean> {
    if (this.rooms.has(roomKey)) return false;
    this.rooms.set(roomKey, room);
    return true;
  }

  async setRoom(
    room: RoomRecord,
    _ttlSeconds?: number,
    roomKey = room.code,
  ): Promise<void> {
    this.rooms.set(roomKey, room);
  }

  async replaceRoom(
    room: RoomRecord,
    _ttlSeconds: number,
    expectedCreatedAt: number,
    roomKey = room.code,
  ): Promise<boolean> {
    const current = this.rooms.get(roomKey);
    if (!current || current.createdAt !== expectedCreatedAt) return false;
    this.rooms.set(roomKey, room);
    return true;
  }

  async getRoom(
    code: string,
    roomKey = code,
  ): Promise<RoomRecord | null> {
    return this.rooms.get(roomKey) || null;
  }

  async deleteRoom(code: string, roomKey = code): Promise<void> {
    this.rooms.delete(roomKey);
  }

  async createCode(
    record: CodeRecord,
    _ttlSeconds: number,
  ): Promise<boolean> {
    const key = `${record.code}:${record.tokenHash}`;
    if (this.codes.has(key)) return false;
    this.codes.set(key, record);
    return true;
  }

  async getCode(
    code: string,
    tokenHash: string,
  ): Promise<CodeRecord | null> {
    return this.codes.get(`${code}:${tokenHash}`) || null;
  }

  async upsertCodeMember(
    code: string,
    tokenHash: string,
    member: CodeMember,
    _ttlSeconds: number,
    maxMembers: number,
  ): Promise<boolean> {
    const key = `${code}:${tokenHash}`;
    const record = this.codes.get(key);
    if (!record) return false;
    if (
      !record.members[member.device.deviceId] &&
      Object.keys(record.members).length >= maxMembers
    ) {
      return false;
    }
    this.codes.set(key, {
      ...record,
      members: {
        ...record.members,
        [member.device.deviceId]: member,
      },
    });
    return true;
  }

  async deleteCode(code: string, tokenHash: string): Promise<void> {
    this.codes.delete(`${code}:${tokenHash}`);
  }

  async isRateLimited(bucket: string, limit: number): Promise<boolean> {
    const count = (this.rates.get(bucket) || 0) + 1;
    this.rates.set(bucket, count);
    return count > limit;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  stats() {
    return {
      rooms: this.rooms.size,
      codes: this.codes.size,
      rateBuckets: this.rates.size,
    };
  }

  close(): void {
    this.rooms.clear();
    this.codes.clear();
    this.rates.clear();
  }
}

interface TestDevice {
  identity: DeviceIdentity;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}

function createDevice(name: string): TestDevice {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    identity: {
      deviceId: createHash("sha256")
        .update(stablePublicKey(jwk))
        .digest("base64url"),
      name,
      publicKey: {
        crv: "P-256",
        kty: "EC",
        x: jwk.x!,
        y: jwk.y!,
      },
    },
  };
}

class TestSocket {
  private readonly queue: ServerWsMessage[] = [];
  private readonly waiters: Array<(message: ServerWsMessage) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerWsMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  async open(
    init: Record<string, unknown> = { type: "session_init" },
  ): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await once(this.socket, "open");
    }
    this.send(init);
  }

  next(): Promise<ServerWsMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return Promise.race([
      new Promise<ServerWsMessage>((resolve) => {
        this.waiters.push(resolve);
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("WebSocket message timeout")), 2_000);
      }),
    ]);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

async function authenticateHost(
  socket: TestSocket,
  device: TestDevice,
  code: string,
): Promise<void> {
  const challenge = await socket.next();
  expect(challenge.type).toBe("challenge");
  if (challenge.type !== "challenge") return;
  const signature = sign(
    "sha256",
    challengePayload(code, challenge.challenge),
    {
      key: device.privateKey,
      dsaEncoding: "ieee-p1363",
    },
  ).toString("base64url");
  socket.send({
    type: "authenticate",
    device: device.identity,
    signature,
  });
  expect((await socket.next()).type).toBe("room_ready");
}

const config: AppConfig = {
  HOST: "127.0.0.1",
  PORT: 3000,
  ROOM_TTL_SECONDS: 300,
  MAX_CODE_MEMBERS: 64,
  MAX_PENDING_ROOMS: 2_000,
  MAX_CODE_RECORDS: 5_000,
  MAX_RATE_BUCKETS: 50_000,
  RATE_LIMIT_CREATE_PER_MINUTE: 12,
  RATE_LIMIT_CREATE_PER_DEVICE_PER_MINUTE: 6,
  RATE_LIMIT_RECONNECT_PER_MINUTE: 60,
  RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE: 30,
  RATE_LIMIT_WS_PER_MINUTE: 60,
  MAX_WS_CONNECTIONS_PER_IP: 12,
  MAX_WS_MESSAGES_PER_MINUTE: 240,
  TURNSTILE_SOFT_LIMIT: 3,
  TURNSTILE_WINDOW_SECONDS: 600,
  TURNSTILE_SITE_KEY: undefined,
  TURNSTILE_SECRET_KEY: undefined,
  TURNSTILE_ALLOWED_HOSTNAMES: [],
  TRUST_PROXY: false,
  STUN_URLS: ["stun:stun.cloudflare.com:3478"],
  MAX_FILE_BYTES: 100_000_000,
  WEB_DIST: "/path/that/does/not/exist",
};

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

describe("security headers", () => {
  it("allows local blob URLs for original media previews", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["content-security-policy"]).toContain(
      "media-src 'self' blob:",
    );
    await app.close();
  });
});

describe("public API protection", () => {
  it("exposes only public configuration and a minimal health response", async () => {
    const store = new MemoryRoomStore();
    const protectedConfig: AppConfig = {
      ...config,
      TURNSTILE_SITE_KEY: "public-site-key",
      TURNSTILE_SECRET_KEY: "private-secret-key",
      TURNSTILE_ALLOWED_HOSTNAMES: ["peerto.example.com"],
    };
    const verifier: TurnstileVerifier = {
      verify: async () => true,
    };
    const app = await buildApp({
      config: protectedConfig,
      store,
      logger: false,
      turnstileVerifier: verifier,
    });

    const publicConfig = await app.inject({
      method: "GET",
      url: "/api/config",
    });
    expect(publicConfig.json()).toMatchObject({
      turnstileSiteKey: "public-site-key",
    });
    expect(publicConfig.body).not.toContain("private-secret-key");

    const health = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(health.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("requires and verifies Turnstile after the soft room limit", async () => {
    const store = new MemoryRoomStore();
    const protectedConfig: AppConfig = {
      ...config,
      TURNSTILE_SITE_KEY: "public-site-key",
      TURNSTILE_SECRET_KEY: "private-secret-key",
      TURNSTILE_ALLOWED_HOSTNAMES: ["peerto.example.com"],
      TURNSTILE_SOFT_LIMIT: 1,
    };
    const verified: Array<{
      token: string;
      remoteIp: string;
      action: string;
    }> = [];
    const verifier: TurnstileVerifier = {
      verify: async (input) => {
        verified.push(input);
        return input.token === "valid-token";
      },
    };
    const app = await buildApp({
      config: protectedConfig,
      store,
      logger: false,
      turnstileVerifier: verifier,
    });
    const device = createDevice("Host");

    const first = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: "203.0.113.10",
      payload: { host: device.identity },
    });
    expect(first.statusCode).toBe(201);

    const challenged = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: "203.0.113.10",
      payload: { host: device.identity },
    });
    expect(challenged.statusCode).toBe(403);
    expect(challenged.json()).toMatchObject({
      error: "TURNSTILE_REQUIRED",
    });

    const passed = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: "203.0.113.10",
      payload: {
        host: device.identity,
        turnstileToken: "valid-token",
      },
    });
    expect(passed.statusCode).toBe(201);
    expect(verified).toEqual([
      {
        token: "valid-token",
        remoteIp: "203.0.113.10",
        action: "create_room",
      },
    ]);
    await app.close();
  });

  it("rejects cross-origin room mutations", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: {
        host: "peerto.example.com",
        origin: "https://attacker.example",
      },
      payload: { host: createDevice("Host").identity },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "INVALID_ORIGIN",
    });
    await app.close();
  });
});

describe("signaling flow", () => {
  it("creates a room, proves the guest device and consumes the code", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const hostDevice = createDevice("Host");
    const guestDevice = createDevice("Guest");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "127.0.0.1",
        payload: { host: hostDevice.identity },
      });
      expect(createResponse.statusCode).toBe(201);
      const room = createResponse.json<{
        code: string;
        hostToken: string;
        connectionToken: string;
      }>();
      expect(room.code).toMatch(/^\d{6}$/);

      const wsBase = address.replace("http:", "ws:");
      const hostRaw = new WebSocket(
        `${wsBase}/ws?role=host&code=${room.code}`,
      );
      sockets.push(hostRaw);
      const host = new TestSocket(hostRaw);
      await host.open({
        type: "session_init",
        token: room.hostToken,
        connectionToken: room.connectionToken,
      });
      await authenticateHost(host, hostDevice, room.code);

      const guestRaw = new WebSocket(
        `${wsBase}/ws?role=guest&code=${room.code}`,
      );
      sockets.push(guestRaw);
      const guest = new TestSocket(guestRaw);
      await guest.open();
      const challengeMessage = await guest.next();
      expect(challengeMessage.type).toBe("challenge");
      if (challengeMessage.type !== "challenge") return;

      const signature = sign(
        "sha256",
        challengePayload(room.code, challengeMessage.challenge),
        {
          key: guestDevice.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      guest.send({
        type: "authenticate",
        device: guestDevice.identity,
        signature,
      });

      const joinRequest = await host.next();
      expect(joinRequest.type).toBe("join_request");
      host.send({
        type: "accept_peer",
        deviceId: guestDevice.identity.deviceId,
      });
      expect((await host.next()).type).toBe("peer_accepted");
      expect((await guest.next()).type).toBe("peer_accepted");

      guest.send({
        type: "signal",
        signal: { kind: "restart_request" },
      });
      expect(await host.next()).toEqual({
        type: "signal",
        signal: { kind: "restart_request" },
      });

      host.send({
        type: "signal",
        signal: { kind: "reconnect_request" },
      });
      expect(await guest.next()).toEqual({
        type: "signal",
        signal: { kind: "reconnect_request" },
      });

      host.send({
        type: "signal",
        signal: {
          kind: "candidate",
          candidate: {
            candidate:
              "candidate:1 1 UDP 2122260223 192.168.1.2 50000 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        },
      });
      expect((await guest.next()).type).toBe("signal");

      const hostClosed = once(hostRaw, "close");
      const guestClosed = once(guestRaw, "close");
      host.send({ type: "connected" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await store.getRoom(room.code)).not.toBeNull();
      guest.send({ type: "connected" });
      expect((await host.next()).type).toBe("room_consumed");
      expect((await guest.next()).type).toBe("room_consumed");
      await Promise.all([hostClosed, guestClosed]);
      expect(await store.getRoom(room.code)).toBeNull();

      const reconnectHostResponse = await app.inject({
        method: "POST",
        url: "/api/rooms/reconnect",
        remoteAddress: "127.0.0.1",
        payload: {
          code: room.code,
          device: hostDevice.identity,
          peerDeviceId: guestDevice.identity.deviceId,
          connectionToken: room.connectionToken,
        },
      });
      expect(
        reconnectHostResponse.json<{ role: string }>().role,
      ).toBe("host");

      const recoveryHostRaw = new WebSocket(
        `${wsBase}/ws?role=host&code=${room.code}`,
      );
      sockets.push(recoveryHostRaw);
      const recoveryHost = new TestSocket(recoveryHostRaw);
      await recoveryHost.open({
        type: "session_init",
        token: room.connectionToken,
        connectionToken: room.connectionToken,
        deviceId: hostDevice.identity.deviceId,
        peerDeviceId: guestDevice.identity.deviceId,
      });
      await authenticateHost(
        recoveryHost,
        hostDevice,
        room.code,
      );

      const reconnectGuestResponse = await app.inject({
        method: "POST",
        url: "/api/rooms/reconnect",
        remoteAddress: "127.0.0.1",
        payload: {
          code: room.code,
          device: guestDevice.identity,
          peerDeviceId: hostDevice.identity.deviceId,
          connectionToken: room.connectionToken,
        },
      });
      expect(
        reconnectGuestResponse.json<{ role: string }>().role,
      ).toBe("guest");

      const recoveryGuestRaw = new WebSocket(
        `${wsBase}/ws?role=guest&code=${room.code}`,
      );
      sockets.push(recoveryGuestRaw);
      const recoveryGuest = new TestSocket(recoveryGuestRaw);
      await recoveryGuest.open({
        type: "session_init",
        connectionToken: room.connectionToken,
        deviceId: guestDevice.identity.deviceId,
        peerDeviceId: hostDevice.identity.deviceId,
      });
      const recoveryChallenge = await recoveryGuest.next();
      expect(recoveryChallenge.type).toBe("challenge");
      if (recoveryChallenge.type !== "challenge") return;
      const recoverySignature = sign(
        "sha256",
        challengePayload(room.code, recoveryChallenge.challenge),
        {
          key: guestDevice.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      recoveryGuest.send({
        type: "authenticate",
        device: guestDevice.identity,
        signature: recoverySignature,
        connectionToken: room.connectionToken,
      });
      expect((await recoveryHost.next()).type).toBe("peer_accepted");
      expect((await recoveryGuest.next()).type).toBe("peer_accepted");
    } finally {
      await app.close();
    }
  });

  it("invalidates a room when the host IP changes", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const hostDevice = createDevice("Host");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "203.0.113.10",
        payload: { host: hostDevice.identity },
      });
      const room = createResponse.json<{
        code: string;
        hostToken: string;
        connectionToken: string;
      }>();
      const hostRaw = new WebSocket(
        `${address.replace("http:", "ws:")}/ws?role=host&code=${room.code}`,
      );
      sockets.push(hostRaw);
      const host = new TestSocket(hostRaw);
      await host.open({
        type: "session_init",
        token: room.hostToken,
        connectionToken: room.connectionToken,
      });
      const closed = await host.next();
      expect(closed).toEqual({
        type: "room_closed",
        reason: "ip_changed",
      });
      expect(await store.getRoom(room.code)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("requires the host to prove possession of its device key", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const hostDevice = createDevice("Proof Host");
    const impostor = createDevice("Impostor");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "127.0.0.1",
        payload: { host: hostDevice.identity },
      });
      const room = response.json<{
        code: string;
        hostToken: string;
        connectionToken: string;
      }>();
      const socketRaw = new WebSocket(
        `${address.replace("http:", "ws:")}/ws?role=host&code=${room.code}`,
      );
      sockets.push(socketRaw);
      const socket = new TestSocket(socketRaw);
      await socket.open({
        type: "session_init",
        token: room.hostToken,
        connectionToken: room.connectionToken,
      });
      const challenge = await socket.next();
      expect(challenge.type).toBe("challenge");
      if (challenge.type !== "challenge") return;
      const invalidSignature = sign(
        "sha256",
        challengePayload(room.code, challenge.challenge),
        {
          key: impostor.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      socket.send({
        type: "authenticate",
        device: hostDevice.identity,
        signature: invalidSignature,
      });
      expect(await socket.next()).toMatchObject({
        type: "error",
        code: "DEVICE_PROOF_FAILED",
      });
    } finally {
      await app.close();
    }
  });

  it("auto-accepts a valid share link token", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const hostDevice = createDevice("Shared Host");
    const guestDevice = createDevice("Shared Guest");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "127.0.0.1",
        payload: { host: hostDevice.identity },
      });
      const room = createResponse.json<{
        code: string;
        hostToken: string;
        shareToken: string;
        connectionToken: string;
      }>();
      expect(room.shareToken.length).toBeGreaterThanOrEqual(32);

      const wsBase = address.replace("http:", "ws:");
      const hostRaw = new WebSocket(
        `${wsBase}/ws?role=host&code=${room.code}`,
      );
      sockets.push(hostRaw);
      const host = new TestSocket(hostRaw);
      await host.open({
        type: "session_init",
        token: room.hostToken,
        connectionToken: room.connectionToken,
      });
      await authenticateHost(host, hostDevice, room.code);

      const guestRaw = new WebSocket(
        `${wsBase}/ws?role=guest&code=${room.code}`,
      );
      sockets.push(guestRaw);
      const guest = new TestSocket(guestRaw);
      await guest.open();
      const challengeMessage = await guest.next();
      expect(challengeMessage.type).toBe("challenge");
      if (challengeMessage.type !== "challenge") return;

      const signature = sign(
        "sha256",
        challengePayload(room.code, challengeMessage.challenge),
        {
          key: guestDevice.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      guest.send({
        type: "authenticate",
        device: guestDevice.identity,
        signature,
        shareToken: room.shareToken,
      });

      expect((await host.next()).type).toBe("peer_accepted");
      expect((await guest.next()).type).toBe("peer_accepted");
    } finally {
      await app.close();
    }
  });

  it("rejects a tampered share link token", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const hostDevice = createDevice("Host");
    const guestDevice = createDevice("Guest");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "127.0.0.1",
        payload: { host: hostDevice.identity },
      });
      const room = createResponse.json<{
        code: string;
        hostToken: string;
        connectionToken: string;
      }>();
      const wsBase = address.replace("http:", "ws:");
      const hostRaw = new WebSocket(
        `${wsBase}/ws?role=host&code=${room.code}`,
      );
      sockets.push(hostRaw);
      const host = new TestSocket(hostRaw);
      await host.open({
        type: "session_init",
        token: room.hostToken,
        connectionToken: room.connectionToken,
      });
      await authenticateHost(host, hostDevice, room.code);

      const guestRaw = new WebSocket(
        `${wsBase}/ws?role=guest&code=${room.code}`,
      );
      sockets.push(guestRaw);
      const guest = new TestSocket(guestRaw);
      await guest.open();
      const challengeMessage = await guest.next();
      if (challengeMessage.type !== "challenge") return;
      const signature = sign(
        "sha256",
        challengePayload(room.code, challengeMessage.challenge),
        {
          key: guestDevice.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      guest.send({
        type: "authenticate",
        device: guestDevice.identity,
        signature,
        shareToken: "x".repeat(48),
      });

      const error = await guest.next();
      expect(error).toMatchObject({
        type: "error",
        code: "INVALID_SHARE_TOKEN",
      });
    } finally {
      await app.close();
    }
  });

  it("rebuilds an N-device code registry without persisted network addresses", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const host = createDevice("Registry Host");
    const guest = createDevice("Registry Guest");
    const third = createDevice("Registry Third");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "198.51.100.10",
        payload: {
          host: host.identity,
        },
      });
      const initial = createResponse.json<{
        code: string;
        connectionToken: string;
      }>();

      store.rooms.clear();
      store.codes.clear();

      const reconnect = (
        device: TestDevice,
        peerDeviceId: string,
        connectionToken = initial.connectionToken,
      ) =>
        app.inject({
          method: "POST",
          url: "/api/rooms/reconnect",
          remoteAddress: "198.51.100.1",
          payload: {
            code: initial.code,
            device: device.identity,
            peerDeviceId,
            connectionToken,
          },
        });

      const [first, second] = await Promise.all([
        reconnect(host, guest.identity.deviceId),
        reconnect(guest, host.identity.deviceId),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(
        [
          first.json<{ role: string }>().role,
          second.json<{ role: string }>().role,
        ].sort(),
      ).toEqual(["guest", "host"]);
      expect(store.rooms.size).toBe(1);

      const pairRoomEntry = [...store.rooms.entries()][0];
      expect(pairRoomEntry).toBeDefined();
      if (!pairRoomEntry) return;
      const [pairRoomKey, pairRoom] = pairRoomEntry;
      store.rooms.set(pairRoomKey, {
        ...pairRoom,
        createdAt: Date.now() - 10_000,
      });
      const [staleFirst, staleSecond] = await Promise.all([
        reconnect(host, guest.identity.deviceId),
        reconnect(guest, host.identity.deviceId),
      ]);
      expect(
        [
          staleFirst.json<{ role: string }>().role,
          staleSecond.json<{ role: string }>().role,
        ].sort(),
      ).toEqual(["guest", "host"]);
      expect(store.rooms.size).toBe(1);

      const thirdResponse = await reconnect(
        third,
        host.identity.deviceId,
      );
      expect(thirdResponse.statusCode).toBe(200);
      expect(store.rooms.size).toBe(2);
      expect([...store.codes.values()][0]?.members).toHaveProperty(
        host.identity.deviceId,
      );
      expect([...store.codes.values()][0]?.members).toHaveProperty(
        guest.identity.deviceId,
      );
      expect([...store.codes.values()][0]?.members).toHaveProperty(
        third.identity.deviceId,
      );

      const otherNamespace = await reconnect(
        host,
        guest.identity.deviceId,
        "different-high-entropy-connection-token-123456789",
      );
      expect(otherNamespace.statusCode).toBe(200);
      expect(store.codes.size).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("restores a paired session after the server-side code registry expires", async () => {
    const store = new MemoryRoomStore();
    const app = await buildApp({ config, store, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const deviceA = createDevice("Device A");
    const deviceB = createDevice("Device B");

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: "127.0.0.1",
        payload: { host: deviceA.identity },
      });
      const pairedCredential = createResponse.json<{
        code: string;
        connectionToken: string;
      }>();

      // Simulate the server losing all of its short-lived in-memory state.
      // The two browsers still retain their paired credential locally.
      store.rooms.clear();
      store.codes.clear();

      const registrations = await Promise.all(
        [
          { device: deviceA, peer: deviceB },
          { device: deviceB, peer: deviceA },
        ].map(async ({ device, peer }) => {
          const response = await app.inject({
            method: "POST",
            url: "/api/rooms/reconnect",
            remoteAddress: "127.0.0.1",
            payload: {
              code: pairedCredential.code,
              device: device.identity,
              peerDeviceId: peer.identity.deviceId,
              connectionToken: pairedCredential.connectionToken,
            },
          });
          expect(response.statusCode).toBe(200);
          return {
            device,
            peer,
            role: response.json<{ role: "host" | "guest" }>().role,
          };
        }),
      );
      const hostRegistration = registrations.find(
        ({ role }) => role === "host",
      );
      const guestRegistration = registrations.find(
        ({ role }) => role === "guest",
      );
      expect(hostRegistration).toBeDefined();
      expect(guestRegistration).toBeDefined();
      if (!hostRegistration || !guestRegistration) return;

      const wsBase = address.replace("http:", "ws:");
      const hostRaw = new WebSocket(
        `${wsBase}/ws?role=host&code=${pairedCredential.code}`,
      );
      sockets.push(hostRaw);
      const host = new TestSocket(hostRaw);
      await host.open({
        type: "session_init",
        token: pairedCredential.connectionToken,
        connectionToken: pairedCredential.connectionToken,
        deviceId: hostRegistration.device.identity.deviceId,
        peerDeviceId: hostRegistration.peer.identity.deviceId,
      });
      await authenticateHost(
        host,
        hostRegistration.device,
        pairedCredential.code,
      );

      const guestRaw = new WebSocket(
        `${wsBase}/ws?role=guest&code=${pairedCredential.code}`,
      );
      sockets.push(guestRaw);
      const guest = new TestSocket(guestRaw);
      await guest.open({
        type: "session_init",
        connectionToken: pairedCredential.connectionToken,
        deviceId: guestRegistration.device.identity.deviceId,
        peerDeviceId: guestRegistration.peer.identity.deviceId,
      });
      const challenge = await guest.next();
      expect(challenge.type).toBe("challenge");
      if (challenge.type !== "challenge") return;
      const signature = sign(
        "sha256",
        challengePayload(pairedCredential.code, challenge.challenge),
        {
          key: guestRegistration.device.privateKey,
          dsaEncoding: "ieee-p1363",
        },
      ).toString("base64url");
      guest.send({
        type: "authenticate",
        device: guestRegistration.device.identity,
        signature,
        connectionToken: pairedCredential.connectionToken,
      });

      expect((await host.next()).type).toBe("peer_accepted");
      expect((await guest.next()).type).toBe("peer_accepted");
      host.send({ type: "connected" });
      guest.send({ type: "connected" });
      expect((await host.next()).type).toBe("room_consumed");
      expect((await guest.next()).type).toBe("room_consumed");
    } finally {
      await app.close();
    }
  });
});
