export type CustomIpFamily = "ipv4" | "ipv6";

function normalizeIpv4(value: string): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const normalized = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const number = Number(part);
    return number <= 255 ? String(number) : undefined;
  });
  if (normalized.some((part) => part === undefined)) return undefined;
  return normalized.join(".");
}

function normalizeIpv6(value: string): string | undefined {
  if (
    !value.includes(":") ||
    value.includes("%") ||
    value.includes("/") ||
    /\s/.test(value)
  ) {
    return undefined;
  }
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
      return undefined;
    }
    const normalized = hostname.slice(1, -1).toLowerCase();
    const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
    if ((firstHextet & 0xffc0) === 0xfe80) {
      return undefined;
    }
    return normalized;
  } catch {
    return undefined;
  }
}

export function normalizeCustomIp(input: string): string | undefined {
  const trimmed = input.trim();
  const value =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return normalizeIpv4(value) || normalizeIpv6(value);
}

export function customIpFamily(ip: string): CustomIpFamily {
  return ip.includes(":") ? "ipv6" : "ipv4";
}

function candidateType(candidate: string): string | undefined {
  const fields = candidate.trim().split(/\s+/);
  const typeIndex = fields.findIndex(
    (field) => field.toLowerCase() === "typ",
  );
  return typeIndex >= 0 ? fields[typeIndex + 1]?.toLowerCase() : undefined;
}

export function customIpIceCandidate(
  candidate: RTCIceCandidateInit,
  customIp: string,
): RTCIceCandidateInit | undefined {
  if (!candidate.candidate) return candidate;
  if (candidateType(candidate.candidate) !== "host") return undefined;

  const fields = candidate.candidate.trim().split(/\s+/);
  if (fields.length < 8) return undefined;
  fields[4] = customIp;
  return { ...candidate, candidate: fields.join(" ") };
}

export function customIpSessionDescription(
  description: RTCSessionDescriptionInit,
  customIp: string,
): RTCSessionDescriptionInit {
  if (!description.sdp) return description;
  const lines = description.sdp.split(/\r?\n/);
  const rewritten = lines.flatMap((line) => {
    if (!line.startsWith("a=candidate:")) return [line];
    const candidate = customIpIceCandidate(
      { candidate: line.slice(2) },
      customIp,
    );
    return candidate ? [`a=${candidate.candidate}`] : [];
  });
  return { ...description, sdp: rewritten.join("\r\n") };
}
