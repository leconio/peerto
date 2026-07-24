import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheLocalResourceFile,
  createWritableFileReceiveTarget,
  deleteCachedResourceFile,
  deleteCachedResourceFileStrict,
  decodeFileChunkFrame,
  encodeFileChunkFrame,
  fileChunkSize,
  getCachedResourceFile,
  removeTemporaryFileReceiveTarget,
  SAFE_FILE_CHUNK_BYTES,
} from "./file-transfer";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileChunkSize", () => {
  it("uses a mobile-safe DataChannel message size by default", () => {
    expect(fileChunkSize()).toBe(SAFE_FILE_CHUNK_BYTES);
    expect(fileChunkSize(Number.POSITIVE_INFINITY)).toBe(
      SAFE_FILE_CHUNK_BYTES,
    );
    expect(fileChunkSize(0)).toBe(SAFE_FILE_CHUNK_BYTES);
  });

  it("never exceeds the negotiated SCTP message size", () => {
    expect(fileChunkSize(8 * 1024)).toBe(8 * 1024);
    expect(fileChunkSize(64 * 1024)).toBe(SAFE_FILE_CHUNK_BYTES);
    expect(fileChunkSize(1.9)).toBe(1);
  });
});

describe("file chunk framing", () => {
  it("round-trips the transfer id, sequence, and payload", () => {
    const transferId = "123e4567-e89b-42d3-a456-426614174000";
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(
      decodeFileChunkFrame(
        encodeFileChunkFrame(transferId, 17, payload),
      ),
    ).toEqual({
      transferId,
      sequence: 17,
      payload,
    });
  });

  it("rejects unframed or malformed data", () => {
    expect(
      decodeFileChunkFrame(new Uint8Array([1, 2, 3]).buffer),
    ).toBeUndefined();
    expect(() =>
      encodeFileChunkFrame("not-a-uuid", 0, new ArrayBuffer(0)),
    ).toThrow("INVALID_FILE_CHUNK_FRAME");
  });
});

describe("file receive targets", () => {
  const transferId = "123e4567-e89b-42d3-a456-426614174000";
  const writable = {
    abort: vi.fn(),
    close: vi.fn(),
    write: vi.fn(),
  } as unknown as FileSystemWritableFileStream;

  it("writes directly to a selected handle when Android permits it", async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      createWritable: vi.fn().mockResolvedValue(writable),
    } as unknown as FileSystemFileHandle;

    const target = await createWritableFileReceiveTarget(
      transferId,
      handle,
    );
    expect(target).toMatchObject({
      mode: "handle",
      handle,
      writable,
    });
  });

  it("falls back to an OPFS chunk file when createWritable fails", async () => {
    const localStorage = new MemoryStorage();
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const temporaryHandle = {
      createWritable: vi.fn().mockResolvedValue(writable),
    } as unknown as FileSystemFileHandle;
    const root = {
      getFileHandle: vi.fn().mockResolvedValue(temporaryHandle),
      removeEntry,
    } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    });
    const selectedHandle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      createWritable: vi.fn().mockRejectedValue(
        new Error("ANDROID_CREATE_FAILED"),
      ),
    } as unknown as FileSystemFileHandle;

    const target = await createWritableFileReceiveTarget(
      transferId,
      selectedHandle,
    );
    expect(target?.mode).toBe("opfs");
    expect(root.getFileHandle).toHaveBeenCalledWith(
      `peerto-receive-${transferId}.part`,
      { create: true },
    );
    expect(localStorage.length).toBe(1);

    await removeTemporaryFileReceiveTarget(target?.temporary);
    expect(removeEntry).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
  });

  it("uses memory only when neither a handle nor OPFS is available", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    expect(
      await createWritableFileReceiveTarget(transferId),
    ).toBeUndefined();
  });

  it("stores, reads, and deletes an original resource without compression", async () => {
    const localStorage = new MemoryStorage();
    const original = new Blob(["original-image-bytes"], {
      type: "image/png",
    }) as File;
    const stored = new File(["original-image-bytes"], "photo.png", {
      type: "image/png",
    });
    const resourceHandle = {
      createWritable: vi.fn().mockResolvedValue(writable),
      getFile: vi.fn().mockResolvedValue(stored),
    } as unknown as FileSystemFileHandle;
    const root = {
      getFileHandle: vi.fn().mockResolvedValue(resourceHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    });

    const resourceKey = await cacheLocalResourceFile(
      original,
      transferId,
    );
    expect(resourceKey).toBe(`peerto-resource-${transferId}`);
    expect(writable.write).toHaveBeenCalledWith(
      await original.arrayBuffer(),
    );
    expect(await getCachedResourceFile(resourceKey!)).toBe(stored);

    await deleteCachedResourceFile(resourceKey!);
    expect(root.removeEntry).toHaveBeenCalledWith(resourceKey);
  });

  it("reports resource deletion failures for coordinated conversation deletion", async () => {
    const root = {
      removeEntry: vi
        .fn()
        .mockRejectedValue(new Error("OPFS_DELETE_FAILED")),
    } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    });

    await expect(
      deleteCachedResourceFileStrict(
        `peerto-resource-${crypto.randomUUID()}`,
      ),
    ).rejects.toThrow("OPFS_DELETE_FAILED");
  });
});
