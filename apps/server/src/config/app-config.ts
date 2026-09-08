import { resolve } from "node:path";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ROOM_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  MAX_CODE_MEMBERS: z.coerce.number().int().min(2).max(256).default(64),
  MAX_PENDING_ROOMS: z.coerce
    .number()
    .int()
    .min(10)
    .max(100_000)
    .default(2_000),
  MAX_CODE_RECORDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(100_000)
    .default(5_000),
  MAX_RATE_BUCKETS: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(50_000),
  RATE_LIMIT_CREATE_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(12),
  RATE_LIMIT_CREATE_PER_DEVICE_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(6),
  RATE_LIMIT_RECONNECT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(60),
  RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(30),
  RATE_LIMIT_WS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(60),
  MAX_WS_CONNECTIONS_PER_IP: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(12),
  MAX_WS_CONNECTIONS: z.coerce.number().int().min(1).max(100_000).default(4_000),
  MAX_WS_MESSAGES_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(10)
    .max(100_000)
    .default(240),
  TURNSTILE_SOFT_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(3),
  TURNSTILE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(600),
  TURNSTILE_SITE_KEY: optionalString,
  TURNSTILE_SECRET_KEY: optionalString,
  TURNSTILE_ALLOWED_HOSTNAMES: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  STUN_URLS: z
    .string()
    .default(
      "stun:stun.chat.bilibili.com:3478,stun:stun.miwifi.com:3478,stun:stun.hitv.com:3478,stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302",
    )
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .default(2_147_483_648),
  WEB_DIST: z.string().default(resolve(process.cwd(), "apps/web/dist")),
}).superRefine((config, context) => {
  const hasSiteKey = Boolean(config.TURNSTILE_SITE_KEY);
  const hasSecretKey = Boolean(config.TURNSTILE_SECRET_KEY);
  if (hasSiteKey !== hasSecretKey) {
    context.addIssue({
      code: "custom",
      message:
        "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together",
      path: hasSiteKey
        ? ["TURNSTILE_SECRET_KEY"]
        : ["TURNSTILE_SITE_KEY"],
    });
  }
  if (
    hasSiteKey &&
    config.TURNSTILE_ALLOWED_HOSTNAMES.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message:
        "TURNSTILE_ALLOWED_HOSTNAMES is required when Turnstile is enabled",
      path: ["TURNSTILE_ALLOWED_HOSTNAMES"],
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
