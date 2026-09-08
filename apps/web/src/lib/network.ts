export type ConnectionRouteKind =
  | "direct"
  | "lan"
  | "ipv4"
  | "ipv6"
  | "relay";

export interface IceCandidateEndpoint {
  address: string | null;
  type: RTCIceCandidateType | null;
  protocol: RTCIceProtocol | null;
}

export interface ConnectionRoute {
  kind: ConnectionRouteKind;
  protocol?: RTCIceProtocol;
  localAddress?: string;
  remoteAddress?: string;
  localCandidateType?: RTCIceCandidateType;
  remoteCandidateType?: RTCIceCandidateType;
}

export interface ParsedIceCandidateAddresses {
  address?: string;
  relatedAddress?: string;
}

export interface SelectedIceCandidatePair {
  local: IceCandidateEndpoint;
  remote: IceCandidateEndpoint;
}

export function peerAddressForRoute(
  route: ConnectionRoute | undefined,
  online: boolean,
): string | undefined {
  if (!online || !route || route.kind === "relay") return undefined;
  return usableConnectionAddress(route.remoteAddress);
}

export function isMdnsCandidateAddress(
  address: string | null | undefined,
): boolean {
  return Boolean(
    address
      ?.trim()
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .endsWith(".local"),
  );
}

export function addressesFromIceCandidateLine(
  candidate: string | null | undefined,
): ParsedIceCandidateAddresses {
  const tokens = candidate
    ?.trim()
    .replace(/^a=/, "")
    .split(/\s+/);
  if (
    !tokens ||
    tokens.length < 8 ||
    !tokens[0]?.startsWith("candidate:")
  ) {
    return {};
  }

  const address = tokens[4];
  const relatedIndex = tokens.indexOf("raddr");
  const relatedAddress =
    relatedIndex >= 0 ? tokens[relatedIndex + 1] : undefined;
  return {
    ...(address ? { address } : {}),
    ...(relatedAddress ? { relatedAddress } : {}),
  };
}

export function usableConnectionAddress(
  address: string | undefined,
): string | undefined {
  if (!address) return undefined;
  const normalized = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!normalized || normalized.endsWith(".local")) {
    return undefined;
  }

  const ipv4 = normalized.split(".");
  if (ipv4.length === 4) {
    const octets = ipv4.map(Number);
    if (
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return undefined;
    }
    const first = octets[0]!;
    if (
      first === 0 ||
      first === 127 ||
      first >= 224
    ) {
      return undefined;
    }
    return normalized;
  }

  if (!normalized.includes(":")) return undefined;
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return undefined;
  }
  return normalized;
}

export function isLanAddress(address: string | undefined): boolean {
  const normalized = usableConnectionAddress(address);
  if (!normalized) return false;

  const ipv4 = normalized.split(".");
  if (ipv4.length === 4) {
    const octets = ipv4.map(Number);
    const [first, second] = octets;
    return (
      first === 10 ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second! >= 64 && second! <= 127)
    );
  }

  const withoutZone = normalized.split("%", 1)[0]!;
  return /^f[cd]/.test(withoutZone) || /^fe[89ab]/.test(withoutZone);
}

export function connectionRouteFromCandidates(
  local: IceCandidateEndpoint,
  remote: IceCandidateEndpoint,
): ConnectionRoute {
  const localAddress = usableConnectionAddress(local.address || undefined);
  const remoteAddress = usableConnectionAddress(remote.address || undefined);
  const protocol = local.protocol || remote.protocol || undefined;
  const route: Omit<ConnectionRoute, "kind"> = {
    ...(protocol ? { protocol } : {}),
    ...(localAddress ? { localAddress } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
    ...(local.type ? { localCandidateType: local.type } : {}),
    ...(remote.type ? { remoteCandidateType: remote.type } : {}),
  };

  if (local.type === "relay" || remote.type === "relay") {
    return { kind: "relay", ...route };
  }

  if (
    local.type === "host" &&
    remote.type === "host" &&
    (isLanAddress(localAddress) ||
      isLanAddress(remoteAddress) ||
      isMdnsCandidateAddress(local.address) ||
      isMdnsCandidateAddress(remote.address))
  ) {
    return { kind: "lan", ...route };
  }

  const familyAddress = localAddress || remoteAddress;
  if (familyAddress?.includes(":")) {
    return { kind: "ipv6", ...route };
  }
  if (familyAddress) {
    return { kind: "ipv4", ...route };
  }
  return { kind: "direct", ...route };
}

export function selectedCandidatePairFromStats(
  stats: Pick<RTCStatsReport, "forEach" | "get">,
): SelectedIceCandidatePair | undefined {
  const reports: Array<RTCStats & Record<string, unknown>> = [];
  stats.forEach((report) => {
    reports.push(report as RTCStats & Record<string, unknown>);
  });

  const transport = reports.find(
    (report) =>
      report.type === "transport" &&
      typeof report.selectedCandidatePairId === "string",
  );
  const selectedPairId =
    typeof transport?.selectedCandidatePairId === "string"
      ? transport.selectedCandidatePairId
      : undefined;
  const candidatePairs = reports.filter(
    (report) => report.type === "candidate-pair",
  );
  const pair =
    (selectedPairId
      ? candidatePairs.find((report) => report.id === selectedPairId)
      : undefined) ||
    candidatePairs
      .filter(
        (report) =>
          report.state === "succeeded" &&
          (report.selected === true || report.nominated === true),
      )
      .sort(
        (left, right) =>
          candidatePairTraffic(right) - candidatePairTraffic(left),
      )[0];

  if (
    !pair ||
    typeof pair.localCandidateId !== "string" ||
    typeof pair.remoteCandidateId !== "string"
  ) {
    return undefined;
  }
  const local = candidateEndpointFromStats(
    stats.get(pair.localCandidateId),
  );
  const remote = candidateEndpointFromStats(
    stats.get(pair.remoteCandidateId),
  );
  return local && remote ? { local, remote } : undefined;
}

export function reconcileConnectionRoutes(
  local: ConnectionRoute | undefined,
  remote:
    | Pick<ConnectionRoute, "kind" | "protocol">
    | undefined,
): ConnectionRoute | undefined {
  if (!local && !remote) return undefined;
  if (!local) return remote ? { ...remote } : undefined;
  if (!remote) return local;

  let kind: ConnectionRouteKind;
  if (local.kind === "relay" || remote.kind === "relay") {
    kind = "relay";
  } else if (local.kind === "lan" || remote.kind === "lan") {
    kind = "lan";
  } else if (local.kind === remote.kind) {
    kind = local.kind;
  } else if (local.kind === "direct") {
    kind = remote.kind;
  } else if (remote.kind === "direct") {
    kind = local.kind;
  } else {
    // Conflicting IP-family observations should not pick one side's view.
    kind = "direct";
  }

  const protocol =
    local.protocol === remote.protocol
      ? local.protocol
      : !local.protocol
        ? remote.protocol
        : !remote.protocol
          ? local.protocol
          : undefined;
  return {
    ...local,
    kind,
    ...(protocol ? { protocol } : {}),
  };
}

function candidatePairTraffic(
  report: RTCStats & Record<string, unknown>,
): number {
  const bytesSent =
    typeof report.bytesSent === "number" ? report.bytesSent : 0;
  const bytesReceived =
    typeof report.bytesReceived === "number"
      ? report.bytesReceived
      : 0;
  return bytesSent + bytesReceived;
}

function candidateEndpointFromStats(
  report: RTCStats | undefined,
): IceCandidateEndpoint | undefined {
  if (!report || report.type.indexOf("candidate") < 0) return undefined;
  const candidate = report as RTCStats & Record<string, unknown>;
  const address =
    typeof candidate.address === "string"
      ? candidate.address
      : typeof candidate.ip === "string"
        ? candidate.ip
        : null;
  const type =
    candidate.candidateType === "host" ||
    candidate.candidateType === "srflx" ||
    candidate.candidateType === "prflx" ||
    candidate.candidateType === "relay"
      ? candidate.candidateType
      : null;
  const protocol =
    candidate.protocol === "udp" || candidate.protocol === "tcp"
      ? candidate.protocol
      : null;
  return { address, type, protocol };
}
