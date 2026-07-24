interface FileMediaMetadata {
  name: string;
  mime: string;
}

export type MediaKind = "image" | "video" | "file";

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  "3gp": "video/3gpp",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};

function extension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function previewMime(file: FileMediaMetadata): string {
  if (
    file.mime.startsWith("image/") ||
    file.mime.startsWith("video/")
  ) {
    return file.mime;
  }
  return (
    MIME_BY_EXTENSION[extension(file.name)] ||
    file.mime ||
    "application/octet-stream"
  );
}

export function mediaKind(file?: FileMediaMetadata): MediaKind {
  if (!file) return "file";
  const mime = previewMime(file);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}
