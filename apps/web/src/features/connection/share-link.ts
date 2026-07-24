import type { RoomInfo } from "../../services/peer";

export interface PendingSharedJoin {
  code: string;
  token: string;
}

export function sharedJoinFromLocation(): PendingSharedJoin | undefined {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("join") || "";
  const token = new URLSearchParams(url.hash.slice(1)).get("token") || "";
  if (url.searchParams.has("join") || url.hash) {
    url.searchParams.delete("join");
    url.hash = "";
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }
  if (!/^\d{6}$/.test(code) || token.length < 32) return undefined;
  return { code, token };
}

export function shareUrl(room: RoomInfo): string {
  if (!room.shareToken) return "";
  const url = new URL(
    window.location.pathname || "/",
    window.location.origin,
  );
  url.searchParams.set("join", room.code);
  url.hash = new URLSearchParams({ token: room.shareToken }).toString();
  return url.toString();
}
