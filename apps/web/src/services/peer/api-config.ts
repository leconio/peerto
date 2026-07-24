import type { ApiConfig } from "./types";

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
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
    const config = (await response.json()) as ApiConfig;
    localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
    return config;
  } catch {
    const cached = localStorage.getItem(CONFIG_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as ApiConfig;
      } catch {
        localStorage.removeItem(CONFIG_CACHE_KEY);
      }
    }
    return FALLBACK_CONFIG;
  }
}
