import type { RuntimeCode } from "./types";

export function runtimeKey(code?: RuntimeCode): string {
  if (!code) return "noContentThroughServer";
  return code.startsWith("server.") ? code : `runtime.${code}`;
}
