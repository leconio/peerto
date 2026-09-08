import type { ApiConfig } from "./types";
import { fetchJson } from "./fetch-json";

const CONFIG_CACHE_KEY = "peerto-api-config";
const FALLBACK_CONFIG: ApiConfig = {
  iceServers: [
    {
      urls: [
        "stun:stun.chat.bilibili.com:3478",
        "stun:stun.miwifi.com:3478",
        "stun:stun.hitv.com:3478",
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
      ],
    },
  ],
  maxFileBytes: 2_147_483_648,
  roomTtlSeconds: 300,
};

export async function loadApiConfig(): Promise<ApiConfig> {
  try {
    const { response, payload } = await fetchJson("/api/config", {}, 5_000);
    if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
    const config = validConfig(payload);
    if (!config) throw new Error("INVALID_CONFIG");
    try {
      localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
    } catch {
      // A storage failure must not discard a valid network response.
    }
    return config;
  } catch {
    try {
      const cached = localStorage.getItem(CONFIG_CACHE_KEY);
      const config = cached ? validConfig(JSON.parse(cached)) : undefined;
      if (config) return config;
    } catch {
      // Config fallback also works when browser storage is unavailable.
    }
    return FALLBACK_CONFIG;
  }
}

function validConfig(value: unknown): ApiConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<ApiConfig>;
  if (
    !Array.isArray(config.iceServers) ||
    !config.iceServers.every(
      (server) =>
        server && typeof server === "object" &&
        (typeof server.urls === "string" ||
          (Array.isArray(server.urls) &&
            server.urls.every((url) => typeof url === "string"))) &&
        (server.username === undefined || typeof server.username === "string") &&
        (server.credential === undefined || typeof server.credential === "string"),
    ) ||
    typeof config.maxFileBytes !== "number" ||
    !Number.isSafeInteger(config.maxFileBytes) ||
    config.maxFileBytes <= 0 ||
    typeof config.roomTtlSeconds !== "number" ||
    !Number.isSafeInteger(config.roomTtlSeconds) ||
    config.roomTtlSeconds <= 0 ||
    (config.turnstileSiteKey !== undefined && typeof config.turnstileSiteKey !== "string") ||
    (config.relayOnly !== undefined && typeof config.relayOnly !== "boolean")
  ) {
    return undefined;
  }
  return config as ApiConfig;
}
