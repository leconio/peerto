import { describe, expect, it, vi } from "vitest";
import { clipboardFiles, insertPastedText } from "./clipboard";

describe("clipboard attachments", () => {
  it("preserves multiple files, including duplicate names, without duplicating files/items", () => {
    const files = [new File(["a"], "same.png"), new File(["a"], "same.png")];
    const result = clipboardFiles({ files, items: files.map(file => ({ kind: "file", getAsFile: () => file })) } as unknown as DataTransfer);
    expect(result).toEqual(files);
    expect(result).toHaveLength(2);
  });
  it("falls back to all file items and ignores text/null items", () => {
    const screenshot = new File(["image"], "image.png", { type: "image/png" });
    const getAsFile = vi.fn();
    expect(clipboardFiles({ files: [], items: [{ kind: "string", getAsFile }, { kind: "file", getAsFile: () => screenshot }, { kind: "file", getAsFile: () => null }] } as unknown as DataTransfer)).toEqual([screenshot]);
    expect(getAsFile).not.toHaveBeenCalled();
  });
  it("leaves text-only clipboard to the browser", () => {
    expect(clipboardFiles({ files: [], items: [] } as unknown as DataTransfer)).toEqual([]);
  });
  it("inserts mixed clipboard text at the selected range, preserving the draft", () => {
    expect(insertPastedText("hello world!", 6, 11, "照片")).toEqual({ value: "hello 照片!", caret: 8 });
  });
});
