import type { ToastNotice } from "../components/Toast";
import { PeerClientError } from "../services/peer";
import { formatBytes } from "./format";

export function errorNotice(
  error: unknown,
  fallbackKey: string,
): ToastNotice {
  if (!(error instanceof PeerClientError)) {
    return { key: fallbackKey };
  }

  const values =
    error.code === "FILE_TOO_LARGE" && error.values?.maxFileBytes
      ? { max: formatBytes(Number(error.values.maxFileBytes)) }
      : error.values;
  return {
    key: `error.${error.code}`,
    ...(values ? { values } : {}),
  };
}
