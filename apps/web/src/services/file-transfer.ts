export const SAFE_FILE_CHUNK_BYTES = 16 * 1024;
export const MAX_QUEUED_FILES = 32;
const FILE_CHUNK_FRAME_MAGIC = 0x50545232;
export const FILE_CHUNK_FRAME_HEADER_BYTES = 24;
const TEMPORARY_FILE_PREFIX = "peerto-receive-";
const TEMPORARY_FILE_INDEX_KEY = "peerto-opfs-temporary-files";
const TEMPORARY_FILE_STALE_MS = 24 * 60 * 60 * 1_000;

export interface FileChunkFrame {
  transferId: string;
  sequence: number;
  payload: ArrayBuffer;
}

export type FileReceiveMode = "handle" | "opfs" | "memory";

export interface WritableFileReceiveTarget {
  mode: "handle" | "opfs";
  writable: FileSystemWritableFileStream;
  handle?: FileSystemFileHandle;
  temporary?: {
    root: FileSystemDirectoryHandle;
    fileHandle: FileSystemFileHandle;
    name: string;
  };
}

interface TemporaryFileIndexEntry {
  name: string;
  createdAt: number;
}

function loadTemporaryFileEntries(): TemporaryFileIndexEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(TEMPORARY_FILE_INDEX_KEY) || "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is TemporaryFileIndexEntry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as TemporaryFileIndexEntry).name ===
              "string" &&
            (entry as TemporaryFileIndexEntry).name.startsWith(
              TEMPORARY_FILE_PREFIX,
            ) &&
            Number.isFinite(
              (entry as TemporaryFileIndexEntry).createdAt,
            ),
        )
      : [];
  } catch {
    return [];
  }
}

function saveTemporaryFileEntries(
  entries: TemporaryFileIndexEntry[],
): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(TEMPORARY_FILE_INDEX_KEY);
    } else {
      localStorage.setItem(
        TEMPORARY_FILE_INDEX_KEY,
        JSON.stringify(entries),
      );
    }
  } catch {
    // Storage metadata is an optional crash-cleanup aid.
  }
}

function rememberTemporaryFile(name: string): void {
  saveTemporaryFileEntries([
    ...loadTemporaryFileEntries().filter((entry) => entry.name !== name),
    { name, createdAt: Date.now() },
  ]);
}

function forgetTemporaryFile(name: string): void {
  saveTemporaryFileEntries(
    loadTemporaryFileEntries().filter((entry) => entry.name !== name),
  );
}

export function supportsOriginPrivateFileSystem(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

async function writableForSelectedHandle(
  handle: FileSystemFileHandle,
): Promise<FileSystemWritableFileStream> {
  if (typeof handle.queryPermission === "function") {
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (
      permission !== "granted" &&
      typeof handle.requestPermission === "function"
    ) {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") {
      throw new Error("FILE_WRITE_PERMISSION_DENIED");
    }
  }
  return handle.createWritable();
}

export async function createWritableFileReceiveTarget(
  transferId: string,
  selectedHandle?: FileSystemFileHandle,
): Promise<WritableFileReceiveTarget | undefined> {
  if (selectedHandle) {
    try {
      return {
        mode: "handle",
        handle: selectedHandle,
        writable: await writableForSelectedHandle(selectedHandle),
      };
    } catch {
      // Android can return a save handle whose createWritable() fails.
      // Continue with OPFS instead of rejecting the transfer.
    }
  }

  if (!supportsOriginPrivateFileSystem()) return undefined;
  const name = `${TEMPORARY_FILE_PREFIX}${transferId}.part`;
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    rememberTemporaryFile(name);
    return {
      mode: "opfs",
      writable,
      temporary: { root, fileHandle, name },
    };
  } catch {
    return undefined;
  }
}

export async function removeTemporaryFileReceiveTarget(
  target: WritableFileReceiveTarget["temporary"],
): Promise<void> {
  if (!target) return;
  try {
    await target.root.removeEntry(target.name);
  } catch {
    // A previous cleanup may already have removed the entry.
  } finally {
    forgetTemporaryFile(target.name);
  }
}

export function retainTemporaryFileReceiveTarget(
  target: NonNullable<WritableFileReceiveTarget["temporary"]>,
): string {
  forgetTemporaryFile(target.name);
  return target.name;
}

export async function getCachedResourceFile(
  resourceKey: string,
): Promise<File | undefined> {
  if (
    !resourceKey.startsWith(TEMPORARY_FILE_PREFIX) &&
    !resourceKey.startsWith("peerto-resource-")
  ) {
    return undefined;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(resourceKey);
    return handle.getFile();
  } catch {
    return undefined;
  }
}

export async function deleteCachedResourceFile(
  resourceKey: string,
): Promise<void> {
  try {
    await deleteCachedResourceFileStrict(resourceKey);
  } catch {
    // Best-effort cleanup is used outside explicit conversation deletion.
  }
}

export async function deleteCachedResourceFileStrict(
  resourceKey: string,
): Promise<void> {
  if (
    !resourceKey.startsWith(TEMPORARY_FILE_PREFIX) &&
    !resourceKey.startsWith("peerto-resource-")
  ) {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(resourceKey);
  } catch (error) {
    if ((error as DOMException | undefined)?.name !== "NotFoundError") {
      throw error;
    }
  }
  forgetTemporaryFile(resourceKey);
}

export async function cacheLocalResourceFile(
  file: File,
  resourceId: string,
): Promise<string | undefined> {
  if (!supportsOriginPrivateFileSystem()) return undefined;
  const resourceKey = `peerto-resource-${resourceId}`;
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(resourceKey, { create: true });
    writable = await handle.createWritable();
    const copyChunkBytes = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += copyChunkBytes) {
      await writable.write(
        await file
          .slice(offset, offset + copyChunkBytes)
          .arrayBuffer(),
      );
    }
    await writable.close();
    return resourceKey;
  } catch {
    try {
      await writable?.abort("RESOURCE_COPY_FAILED");
    } catch {
      // The browser may already have closed the partial resource.
    }
    await deleteCachedResourceFile(resourceKey);
    return undefined;
  }
}

export async function cleanupStaleTemporaryFileReceives(): Promise<void> {
  const entries = loadTemporaryFileEntries();
  const staleEntries = entries.filter(
    (entry) => Date.now() - entry.createdAt >= TEMPORARY_FILE_STALE_MS,
  );
  if (
    staleEntries.length === 0 ||
    !supportsOriginPrivateFileSystem()
  ) {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    await Promise.allSettled(
      staleEntries.map((entry) => root.removeEntry(entry.name)),
    );
    const staleNames = new Set(
      staleEntries.map((entry) => entry.name),
    );
    saveTemporaryFileEntries(
      loadTemporaryFileEntries().filter(
        (entry) => !staleNames.has(entry.name),
      ),
    );
  } catch {
    // Try again on the next application start.
  }
}

function uuidBytes(value: string): Uint8Array | undefined {
  const normalized = value.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function encodeFileChunkFrame(
  transferId: string,
  sequence: number,
  payload: ArrayBuffer,
): ArrayBuffer {
  const id = uuidBytes(transferId);
  if (!id || !Number.isInteger(sequence) || sequence < 0) {
    throw new Error("INVALID_FILE_CHUNK_FRAME");
  }
  const frame = new ArrayBuffer(
    FILE_CHUNK_FRAME_HEADER_BYTES + payload.byteLength,
  );
  const view = new DataView(frame);
  view.setUint32(0, FILE_CHUNK_FRAME_MAGIC);
  new Uint8Array(frame, 4, 16).set(id);
  view.setUint32(20, sequence);
  new Uint8Array(frame, FILE_CHUNK_FRAME_HEADER_BYTES).set(
    new Uint8Array(payload),
  );
  return frame;
}

export function decodeFileChunkFrame(
  frame: ArrayBuffer,
): FileChunkFrame | undefined {
  if (frame.byteLength < FILE_CHUNK_FRAME_HEADER_BYTES) return undefined;
  const view = new DataView(frame);
  if (view.getUint32(0) !== FILE_CHUNK_FRAME_MAGIC) return undefined;
  return {
    transferId: uuidFromBytes(new Uint8Array(frame, 4, 16)),
    sequence: view.getUint32(20),
    payload: frame.slice(FILE_CHUNK_FRAME_HEADER_BYTES),
  };
}

export function fileChunkSize(maxMessageSize?: number | null): number {
  if (
    typeof maxMessageSize !== "number" ||
    !Number.isFinite(maxMessageSize) ||
    maxMessageSize <= 0
  ) {
    return SAFE_FILE_CHUNK_BYTES;
  }

  return Math.max(
    1,
    Math.min(SAFE_FILE_CHUNK_BYTES, Math.floor(maxMessageSize)),
  );
}

export function downloadBlob(
  blob: Blob,
  fileName: string,
  afterDownload?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    void afterDownload?.();
  }, 30_000);
}
