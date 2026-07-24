export const DEFAULT_MAX_ACTIVE_PEER_CLIENTS = 4;
export const MIN_MAX_ACTIVE_PEER_CLIENTS = 1;
export const MAX_MAX_ACTIVE_PEER_CLIENTS = 32;

const STORAGE_KEY = "peerto-max-active-peer-clients";

export function normalizeMaxActivePeerClients(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ACTIVE_PEER_CLIENTS;
  return Math.min(
    MAX_MAX_ACTIVE_PEER_CLIENTS,
    Math.max(MIN_MAX_ACTIVE_PEER_CLIENTS, Math.trunc(value)),
  );
}

export function loadMaxActivePeerClients(): number {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return DEFAULT_MAX_ACTIVE_PEER_CLIENTS;
  return normalizeMaxActivePeerClients(Number(saved));
}

export function saveMaxActivePeerClients(value: number): number {
  const normalized = normalizeMaxActivePeerClients(value);
  localStorage.setItem(STORAGE_KEY, String(normalized));
  return normalized;
}
