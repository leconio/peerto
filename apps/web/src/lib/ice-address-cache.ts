import { usableConnectionAddress } from "./network";

const ICE_ADDRESS_CACHE_KEY = "peerto-last-ice-addresses";
const ICE_ADDRESS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CACHED_ADDRESSES = 32;

interface IceAddressCacheRecord {
  addresses: string[];
  savedAt: number;
}

export function parseCachedIceAddresses(
  raw: string | null,
  now = Date.now(),
): string[] {
  if (!raw) return [];
  try {
    const record = JSON.parse(raw) as Partial<IceAddressCacheRecord>;
    if (
      !Array.isArray(record.addresses) ||
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt) ||
      record.savedAt > now ||
      now - record.savedAt > ICE_ADDRESS_CACHE_MAX_AGE_MS
    ) {
      return [];
    }
    return [
      ...new Set(
        record.addresses
          .map((address) =>
            typeof address === "string"
              ? usableConnectionAddress(address)
              : undefined,
          )
          .filter((address): address is string => Boolean(address)),
      ),
    ].slice(0, MAX_CACHED_ADDRESSES);
  } catch {
    return [];
  }
}

export function loadCachedIceAddresses(): string[] {
  try {
    return parseCachedIceAddresses(
      localStorage.getItem(ICE_ADDRESS_CACHE_KEY),
    );
  } catch {
    return [];
  }
}

export function saveCachedIceAddresses(addresses: string[]): void {
  const normalized = [
    ...new Set(
      addresses
        .map(usableConnectionAddress)
        .filter((address): address is string => Boolean(address)),
    ),
  ].slice(0, MAX_CACHED_ADDRESSES);
  if (normalized.length === 0) return;
  try {
    localStorage.setItem(
      ICE_ADDRESS_CACHE_KEY,
      JSON.stringify({
        addresses: normalized,
        savedAt: Date.now(),
      } satisfies IceAddressCacheRecord),
    );
  } catch {
    // Address display still works for the current page session.
  }
}
