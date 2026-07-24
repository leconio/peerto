import { randomInt } from "node:crypto";
import {
  createRoomRequestSchema,
  reconnectRoomRequestSchema,
} from "@peerto/protocol";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/app-config";
import {
  hashToken,
  randomToken,
  verifyDeviceIdentity,
} from "../security/device-auth";
import type { TurnstileVerifier } from "../security/turnstile";
import { reconnectRoomKey } from "../signaling/room-key";
import type { RuntimeRoomMap } from "../signaling/runtime-room";
import { closeSocket } from "../signaling/socket-utils";
import type {
  RoomRecord,
  RoomStore,
} from "../storage/room-store";

const CODE_ATTEMPTS = 30;
const RUNTIME_START_GRACE_MS = 5_000;

export interface ApiRoutesOptions {
  config: AppConfig;
  store: RoomStore;
  runtimeRooms: RuntimeRoomMap;
  turnstileVerifier?: TurnstileVerifier;
}

export function registerApiRoutes(
  app: FastifyInstance,
  {
    config,
    store,
    runtimeRooms,
    turnstileVerifier,
  }: ApiRoutesOptions,
): void {
  app.get("/api/health", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  app.get("/api/config", async (_request, reply) => {
    reply.header("Cache-Control", "private, max-age=300");
    return {
      iceServers: [{ urls: config.STUN_URLS }],
      maxFileBytes: config.MAX_FILE_BYTES,
      roomTtlSeconds: config.ROOM_TTL_SECONDS,
      ...(config.TURNSTILE_SITE_KEY
        ? { turnstileSiteKey: config.TURNSTILE_SITE_KEY }
        : {}),
    };
  });

  app.post("/api/rooms", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hasValidOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({
        error: "INVALID_ORIGIN",
        message: "请求来源无效",
      });
    }
    if (
      await store.isRateLimited(
        `create:${request.ip}`,
        config.RATE_LIMIT_CREATE_PER_MINUTE,
        60,
      )
    ) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "生成连接码过于频繁，请稍后重试",
      });
    }

    const parsed = createRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "设备信息无效",
      });
    }
    if (!verifyDeviceIdentity(parsed.data.host)) {
      return reply.code(400).send({
        error: "INVALID_DEVICE",
        message: "设备身份校验失败",
      });
    }
    if (
      await store.isRateLimited(
        `create-device:${parsed.data.host.deviceId}`,
        config.RATE_LIMIT_CREATE_PER_DEVICE_PER_MINUTE,
        60,
      )
    ) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "此设备生成连接码过于频繁，请稍后重试",
      });
    }

    if (
      config.TURNSTILE_SITE_KEY &&
      turnstileVerifier &&
      !parsed.data.turnstileToken &&
      (await store.isRateLimited(
        `turnstile:create:${request.ip}`,
        config.TURNSTILE_SOFT_LIMIT,
        config.TURNSTILE_WINDOW_SECONDS,
      ))
    ) {
      return reply.code(403).send({
        error: "TURNSTILE_REQUIRED",
        message: "请完成人机验证后重试",
      });
    }
    if (
      parsed.data.turnstileToken &&
      (!turnstileVerifier ||
        !(await turnstileVerifier.verify({
          token: parsed.data.turnstileToken,
          remoteIp: request.ip,
          action: "create_room",
        })))
    ) {
      return reply.code(403).send({
        error: "TURNSTILE_FAILED",
        message: "人机验证失败或已失效，请重试",
      });
    }

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      if (runtimeRooms.has(code)) continue;
      const hostToken = randomToken();
      const shareToken = randomToken();
      const connectionToken = randomToken();
      const connectionTokenHash = hashToken(connectionToken);
      const createdAt = Date.now();
      const codeCreated = await store.createCode(
        {
          code,
          tokenHash: connectionTokenHash,
          members: {
            [parsed.data.host.deviceId]: {
              device: parsed.data.host,
              updatedAt: createdAt,
            },
          },
          createdAt,
        },
        config.ROOM_TTL_SECONDS,
      );
      if (!codeCreated) continue;
      const record: RoomRecord = {
        code,
        host: parsed.data.host,
        hostIp: request.ip,
        hostTokenHash: hashToken(hostToken),
        shareTokenHash: hashToken(shareToken),
        resume: false,
        createdAt,
        expiresAt: createdAt + config.ROOM_TTL_SECONDS * 1_000,
      };
      if (await store.createRoom(record, config.ROOM_TTL_SECONDS)) {
        return reply.code(201).send({
          code,
          expiresAt: record.expiresAt,
          hostToken,
          shareToken,
          connectionToken,
        });
      }
      await store.deleteCode(code, connectionTokenHash);
    }

    return reply.code(503).send({
      error: "CODE_POOL_BUSY",
      message: "暂时无法生成连接码，请重试",
    });
  });

  app.post("/api/rooms/reconnect", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hasValidOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({
        error: "INVALID_ORIGIN",
        message: "请求来源无效",
      });
    }
    if (
      await store.isRateLimited(
        `reconnect:${request.ip}`,
        config.RATE_LIMIT_RECONNECT_PER_MINUTE,
        60,
      )
    ) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "重新连接过于频繁，请稍后重试",
      });
    }

    const parsed = reconnectRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "配对信息无效",
      });
    }
    if (!verifyDeviceIdentity(parsed.data.device)) {
      return reply.code(400).send({
        error: "INVALID_DEVICE",
        message: "设备身份校验失败",
      });
    }
    if (
      await store.isRateLimited(
        `reconnect-device:${parsed.data.device.deviceId}`,
        config.RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE,
        60,
      )
    ) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "此设备重新连接过于频繁，请稍后重试",
      });
    }

    const { code, device, peerDeviceId, connectionToken } = parsed.data;
    const tokenHash = hashToken(connectionToken);
    let codeRecord = await store.getCode(code, tokenHash);
    const member = {
      device,
      updatedAt: Date.now(),
    };
    if (!codeRecord) {
      await store.createCode(
        {
          code,
          tokenHash,
          members: { [device.deviceId]: member },
          createdAt: Date.now(),
        },
        config.ROOM_TTL_SECONDS,
      );
    }
    const memberRegistered = await store.upsertCodeMember(
      code,
      tokenHash,
      member,
      config.ROOM_TTL_SECONDS,
      config.MAX_CODE_MEMBERS,
    );
    if (!memberRegistered) {
      return reply.code(409).send({
        error: "CODE_MEMBER_LIMIT",
        message: "此配对凭证登记的设备数量已达到上限",
      });
    }
    codeRecord =
      (await store.getCode(code, tokenHash)) || {
        code,
        tokenHash,
        members: { [device.deviceId]: member },
        createdAt: Date.now(),
      };
    const roomKey = reconnectRoomKey(
      code,
      connectionToken,
      device.deviceId,
      peerDeviceId,
    );
    const existing = await store.getRoom(code, roomKey);
    const runtime = runtimeRooms.get(roomKey);
    if (
      existing?.resume &&
      existing.expiresAt > Date.now() &&
      (runtime ||
        Date.now() - existing.createdAt < RUNTIME_START_GRACE_MS)
    ) {
      return reply.send({
        code,
        expiresAt: existing.expiresAt,
        role:
          existing.host.deviceId === device.deviceId ? "host" : "guest",
      });
    }

    if (runtime) {
      clearTimeout(runtime.expiryTimer);
      closeSocket(runtime.host.socket);
      if (runtime.guest) closeSocket(runtime.guest.socket);
      runtimeRooms.delete(roomKey);
    }

    const createdAt = Date.now();
    const room: RoomRecord = {
      code,
      host: device,
      hostIp: request.ip,
      hostTokenHash: codeRecord.tokenHash,
      shareTokenHash: codeRecord.tokenHash,
      resume: true,
      peerDeviceId,
      createdAt,
      expiresAt: createdAt + config.ROOM_TTL_SECONDS * 1_000,
    };
    if (!existing) {
      const created = await store.createRoom(
        room,
        config.ROOM_TTL_SECONDS,
        roomKey,
      );
      if (!created) {
        const winner = await store.getRoom(code, roomKey);
        if (winner && winner.expiresAt > Date.now()) {
          return reply.send({
            code,
            expiresAt: winner.expiresAt,
            role:
              winner.host.deviceId === device.deviceId
                ? "host"
                : "guest",
          });
        }
        await store.setRoom(room, config.ROOM_TTL_SECONDS, roomKey);
      }
    } else {
      const replaced = await store.replaceRoom(
        room,
        config.ROOM_TTL_SECONDS,
        existing.createdAt,
        roomKey,
      );
      if (!replaced) {
        const winner = await store.getRoom(code, roomKey);
        if (winner && winner.expiresAt > Date.now()) {
          return reply.send({
            code,
            expiresAt: winner.expiresAt,
            role:
              winner.host.deviceId === device.deviceId
                ? "host"
                : "guest",
          });
        }
        await store.setRoom(room, config.ROOM_TTL_SECONDS, roomKey);
      }
    }
    return reply.send({
      code,
      expiresAt: room.expiresAt,
      role: "host",
    });
  });
}

function hasValidOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
