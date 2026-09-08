import type { RoomInfo } from "../../services/peer";

export interface PendingSharedJoin {
  code: string;
  token: string;
}

export function sharedJoinFromLocation(): PendingSharedJoin | undefined {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("join") || "";
  const token = new URLSearchParams(url.hash.slice(1)).get("token") || "";
  // This is read during React render (including StrictMode replays). Keep it
  // pure; onboarding/reloads must not lose an invitation before identity loads.
  if (!/^\d{6}$/.test(code) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return undefined;
  return { code, token };
}

export function consumeSharedJoin(pending: PendingSharedJoin): void {
  const current = sharedJoinFromLocation();
  if (current?.code !== pending.code || current.token !== pending.token) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("join");
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete("token");
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
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
