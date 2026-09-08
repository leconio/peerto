export type DiagnosticFields = Record<string, string | number | boolean | undefined>;

const serverErrors = new Set([
  "RATE_LIMITED", "INVALID_REQUEST", "INVALID_DEVICE", "CODE_POOL_BUSY", "CODE_MEMBER_LIMIT",
  "INVALID_QUERY", "INVALID_HOST_TOKEN", "INVALID_JSON", "INVALID_MESSAGE", "DEVICE_PROOF_FAILED",
  "DEVICE_PROOF_TIMEOUT", "SIGNALING_UNAVAILABLE", "ROOM_UNAVAILABLE", "ROOM_OCCUPIED",
  "INVALID_SHARE_TOKEN", "INVALID_CODE_MEMBERSHIP", "FILE_TOO_LARGE", "FILE_RECEIVE_BUSY",
]);

export function diagnosticDetail(detail: string | undefined): string | undefined {
  if (!detail?.startsWith("server.")) return detail;
  return serverErrors.has(detail.slice(7)) ? detail : "server.unknown";
}

// Never log raw errors, SDP, candidate lines, URLs, identities or credentials.
export function rtcErrorFields(error: unknown): DiagnosticFields {
  const value = error as { name?: unknown; errorDetail?: unknown; sdpLineNumber?: unknown } | null;
  const names = ["Error", "TypeError", "OperationError", "InvalidStateError", "InvalidAccessError",
    "NotSupportedError", "NotAllowedError", "AbortError", "NetworkError", "RTCError", "SyntaxError"];
  const details = ["data-channel-failure", "dtls-failure", "fingerprint-failure", "sctp-failure",
    "sdp-syntax-error", "hardware-encoder-error", "hardware-encoder-not-available"];
  return {
    error: names.includes(String(value?.name)) ? String(value?.name) : "UnknownError",
    ...(details.includes(String(value?.errorDetail)) ? { errorDetail: String(value?.errorDetail) } : {}),
    ...(typeof value?.sdpLineNumber === "number" ? { sdpLine: value.sdpLineNumber } : {}),
  };
}

export function descriptionFields(description: { type: RTCSdpType; sdp?: string | undefined }): DiagnosticFields {
  const sdp = description.sdp || "";
  return {
    descriptionType: description.type,
    sdpBytes: new TextEncoder().encode(sdp).length,
    mediaSections: (sdp.match(/^m=/gm) || []).length,
    hasIceCredentials: /^a=ice-ufrag:/m.test(sdp) && /^a=ice-pwd:/m.test(sdp),
    hasFingerprint: /^a=fingerprint:/m.test(sdp),
  };
}

export function candidateFields(candidate: {
  candidate?: string | undefined; usernameFragment?: string | null | undefined; sdpMLineIndex?: number | null | undefined;
}): DiagnosticFields {
  const line = candidate.candidate || "";
  const fields = line.trim().split(/\s+/);
  const type = /(?:^|\s)typ\s+(\S+)/.exec(line)?.[1];
  const protocol = fields[2]?.toLowerCase();
  return {
    candidateType: ["host", "srflx", "prflx", "relay"].includes(type || "") ? type : "unknown",
    protocol: protocol === "udp" || protocol === "tcp" ? protocol : "unknown",
    addressFamily: fields[4]?.endsWith(".local") ? "mdns" : fields[4]?.includes(":") ? "ipv6" : "ipv4",
    endOfCandidates: line.length === 0,
    hasGeneration: Boolean(candidate.usernameFragment || /\sufrag\s/.test(line)),
    ...(candidate.sdpMLineIndex != null ? { mediaIndex: candidate.sdpMLineIndex } : {}),
  };
}
