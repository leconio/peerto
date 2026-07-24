import { getFileHandle } from "../../lib/database";
import { mediaKind, previewMime } from "../../lib/media";
import type { StoredFile } from "../../store";
import { getCachedResourceFile } from "../../services/file-transfer";

export function isImageFile(file?: StoredFile): boolean {
  return mediaKind(file) === "image";
}

export function isVideoFile(file?: StoredFile): boolean {
  return mediaKind(file) === "video";
}

export async function readStoredResourceFile(
  file: StoredFile,
  requestPermission: boolean,
): Promise<File | undefined> {
  if (file.resourceKey) {
    const cached = await getCachedResourceFile(file.resourceKey);
    if (cached) {
      return new File([cached], file.name, {
        type: previewMime(file),
        lastModified: cached.lastModified,
      });
    }
  }
  if (!file.handleKey) return undefined;
  const handle = await getFileHandle(file.handleKey);
  if (!handle) return undefined;
  let permission = await handle.queryPermission({ mode: "read" });
  if (permission !== "granted" && requestPermission) {
    permission = await handle.requestPermission({ mode: "read" });
  }
  if (permission !== "granted") return undefined;
  const stored = await handle.getFile();
  return new File([stored], file.name, {
    type: previewMime(file),
    lastModified: stored.lastModified,
  });
}
