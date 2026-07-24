export interface TurnServerSettings {
  url: string;
  username: string;
  credential: string;
}

export interface IceServerSettings {
  stunUrls: string[];
  turn: TurnServerSettings;
  relayOnly?: boolean;
}

export type IceSettingsValidationError =
  | "NO_ICE_SERVERS"
  | "RELAY_ONLY_REQUIRES_TURN"
  | "INVALID_STUN_URL"
  | "INVALID_TURN_URL";

export const DEFAULT_STUN_URLS = [
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.miwifi.com:3478",
  "stun:stun.hitv.com:3478",
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
];

const ICE_SETTINGS_STORAGE_KEY = "peerto-ice-settings";

function urlsOf(server: RTCIceServer): string[] {
  return typeof server.urls === "string" ? [server.urls] : server.urls;
}

function hasScheme(value: string, schemes: string[]): boolean {
  const normalized = value.trim().toLowerCase();
  return schemes.some((scheme) => normalized.startsWith(`${scheme}:`));
}

function normalizedLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeIceServerSettings(
  settings: IceServerSettings,
): IceServerSettings {
  return {
    stunUrls: [
      ...new Set(settings.stunUrls.map((url) => url.trim()).filter(Boolean)),
    ],
    turn: {
      url: normalizedLines(settings.turn.url).join("\n"),
      username: settings.turn.username.trim(),
      credential: settings.turn.credential,
    },
    relayOnly: Boolean(settings.relayOnly),
  };
}

export function iceServerSettingsFromRtc(
  servers: RTCIceServer[],
): IceServerSettings {
  const stunUrls: string[] = [];
  const turnUrls: string[] = [];
  let turnUsername = "";
  let turnCredential = "";

  for (const server of servers) {
    for (const url of urlsOf(server)) {
      if (hasScheme(url, ["stun", "stuns"])) {
        stunUrls.push(url);
      } else if (hasScheme(url, ["turn", "turns"])) {
        turnUrls.push(url);
        if (!turnUsername && server.username) {
          turnUsername = server.username;
        }
        if (
          !turnCredential &&
          typeof server.credential === "string"
        ) {
          turnCredential = server.credential;
        }
      }
    }
  }

  return normalizeIceServerSettings({
    stunUrls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS,
    turn: {
      url: turnUrls.join("\n"),
      username: turnUsername,
      credential: turnCredential,
    },
    relayOnly: false,
  });
}

export function validateIceServerSettings(
  settings: IceServerSettings,
): IceSettingsValidationError | undefined {
  const normalized = normalizeIceServerSettings(settings);
  if (
    normalized.stunUrls.some(
      (url) => !hasScheme(url, ["stun", "stuns"]),
    )
  ) {
    return "INVALID_STUN_URL";
  }
  const turnUrls = normalizedLines(normalized.turn.url);
  if (turnUrls.some((url) => !hasScheme(url, ["turn", "turns"]))) {
    return "INVALID_TURN_URL";
  }
  if (normalized.stunUrls.length === 0 && !normalized.turn.url) {
    return "NO_ICE_SERVERS";
  }
  if (normalized.relayOnly && !normalized.turn.url) {
    return "RELAY_ONLY_REQUIRES_TURN";
  }
  return undefined;
}

export function rtcIceServersFromSettings(
  settings: IceServerSettings,
): RTCIceServer[] {
  const normalized = normalizeIceServerSettings(settings);
  const servers: RTCIceServer[] = [];
  if (normalized.stunUrls.length > 0) {
    servers.push({ urls: normalized.stunUrls });
  }
  if (normalized.turn.url) {
    const turnUrls = normalizedLines(normalized.turn.url);
    servers.push({
      urls: turnUrls,
      username: normalized.turn.username,
      credential: normalized.turn.credential,
    });
  }
  return servers;
}

export function loadIceServerSettings(
  defaultServers: RTCIceServer[],
): IceServerSettings {
  const defaults = iceServerSettingsFromRtc(defaultServers);
  const saved = localStorage.getItem(ICE_SETTINGS_STORAGE_KEY);
  if (!saved) return defaults;

  try {
    const value = JSON.parse(saved) as Partial<IceServerSettings>;
    if (
      !Array.isArray(value.stunUrls) ||
      !value.stunUrls.every((url) => typeof url === "string") ||
      !value.turn ||
      typeof value.turn.url !== "string" ||
      typeof value.turn.username !== "string" ||
      typeof value.turn.credential !== "string" ||
      (value.relayOnly !== undefined &&
        typeof value.relayOnly !== "boolean")
    ) {
      throw new Error("INVALID_ICE_SETTINGS");
    }
    const settings = normalizeIceServerSettings({
      stunUrls: value.stunUrls,
      turn: value.turn,
      relayOnly: Boolean(value.relayOnly),
    });
    if (validateIceServerSettings(settings)) {
      throw new Error("INVALID_ICE_SETTINGS");
    }
    return settings;
  } catch {
    localStorage.removeItem(ICE_SETTINGS_STORAGE_KEY);
    return defaults;
  }
}

export function saveIceServerSettings(settings: IceServerSettings): void {
  localStorage.setItem(
    ICE_SETTINGS_STORAGE_KEY,
    JSON.stringify(normalizeIceServerSettings(settings)),
  );
}
