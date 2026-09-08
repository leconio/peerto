/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  theme: "auto" | "light" | "dark";
  size: "normal" | "compact" | "flexible";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: TurnstileRenderOptions,
  ): string;
  remove(widgetId: string): void;
}

interface Window {
  turnstile?: TurnstileApi;
}

interface FileSystemHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
  isSameEntry(other: FileSystemHandle): Promise<boolean>;
  queryPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: "file";
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
  }): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface Window {
  showOpenFilePicker?(options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }): Promise<FileSystemFileHandle>;
}
