import { describe, expect, it } from "vitest";
import { mediaKind, previewMime } from "./media";

describe("media preview metadata", () => {
  it("uses a declared image or video MIME type", () => {
    expect(mediaKind({ name: "asset.bin", mime: "image/png" })).toBe(
      "image",
    );
    expect(mediaKind({ name: "asset.bin", mime: "video/mp4" })).toBe(
      "video",
    );
  });

  it("recovers preview MIME types from mobile file extensions", () => {
    expect(
      previewMime({
        name: "camera-photo.JPG",
        mime: "application/octet-stream",
      }),
    ).toBe("image/jpeg");
    expect(mediaKind({ name: "clip.MOV", mime: "" })).toBe("video");
  });

  it("keeps unknown documents as files", () => {
    expect(mediaKind({ name: "document.pdf", mime: "application/pdf" })).toBe(
      "file",
    );
  });
});
