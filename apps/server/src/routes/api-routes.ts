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
import { RecoveryRegistrationError, registerRecovery } from "../signaling/register-recovery";
import type { RuntimeRoomMap } from "../signaling/runtime-room";
import type {
  RoomRecord,
  RoomStore,
} from "../storage/room-store";

const CODE_ATTEMPTS = 30;

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
  app.get("/api/health", { logLevel: "silent" }, async (_request, reply) => {
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
        id: randomToken(),
        code,
        host: parsed.data.host,

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
    const parsed = reconnectRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "配对信息无效" });
    try {
      const { room } = await registerRecovery(store, config, parsed.data, request.ip);
      return reply.send({ code: room.code, expiresAt: room.expiresAt,
        role: room.host.deviceId === parsed.data.device.deviceId ? "host" : "guest" });
    } catch (error) {
      if (!(error instanceof RecoveryRegistrationError)) throw error;
      if (error.status === 429) reply.header("Retry-After", "60");
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
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
