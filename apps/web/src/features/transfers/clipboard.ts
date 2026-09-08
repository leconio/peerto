export function clipboardFiles(data: Pick<DataTransfer, "files" | "items">): File[] {
  // files/items usually describe the same payload: do not concatenate them.
  // Preserve distinct files even if their names, sizes and timestamps match.
  const files = Array.from(data.files);
  if (files.length) return files;
  return Array.from(data.items).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export function insertPastedText(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}

export interface PendingAttachment {
  id: string;
  file: File;
  handle?: FileSystemFileHandle;
}
