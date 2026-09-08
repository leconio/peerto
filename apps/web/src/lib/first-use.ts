export const APP_STATE_STORAGE_KEY = "peerto-app-v3";
export const FIRST_DEVICE_NAME_STORAGE_KEY =
  "peerto-first-device-name-v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

export function normalizedDeviceName(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, 64).join("");
}

export function loadFirstDeviceName(
  storage: ReadableStorage,
): string | undefined {
  try {
    return normalizedDeviceName(
      storage.getItem(FIRST_DEVICE_NAME_STORAGE_KEY),
    );
  } catch {
    return undefined;
  }
}

export function needsFirstDeviceName(
  storage: ReadableStorage,
): boolean {
  try {
    return (
      !loadFirstDeviceName(storage) &&
      !storage.getItem(APP_STATE_STORAGE_KEY)
    );
  } catch {
    return true;
  }
}

export function saveFirstDeviceName(
  storage: WritableStorage,
  value: string,
): string | undefined {
  const normalized = normalizedDeviceName(value);
  if (!normalized) return undefined;
  try {
    storage.setItem(FIRST_DEVICE_NAME_STORAGE_KEY, normalized);
    return normalized;
  } catch {
    return undefined;
  }
}
