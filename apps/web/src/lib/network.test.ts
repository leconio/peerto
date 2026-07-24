import { describe, expect, it } from "vitest";
import {
  addressesFromIceCandidateLine,
  connectionRouteFromCandidates,
  isLanAddress,
  isMdnsCandidateAddress,
  reconcileConnectionRoutes,
  selectedCandidatePairFromStats,
  usableConnectionAddress,
} from "./network";

describe("usableConnectionAddress", () => {
  it("keeps public IPv4 and IPv6 addresses", () => {
    expect(usableConnectionAddress("8.8.8.8")).toBe("8.8.8.8");
    expect(usableConnectionAddress("[2606:4700:4700::1111]")).toBe(
      "2606:4700:4700::1111",
    );
  });

  it("keeps LAN, carrier-grade NAT, and link-local addresses", () => {
    expect(usableConnectionAddress("192.168.1.2")).toBe("192.168.1.2");
    expect(usableConnectionAddress("10.0.0.8")).toBe("10.0.0.8");
    expect(usableConnectionAddress("100.64.1.2")).toBe("100.64.1.2");
    expect(usableConnectionAddress("fe80::1%en0")).toBe("fe80::1%en0");
    expect(usableConnectionAddress("fd00::1")).toBe("fd00::1");
  });

  it("rejects loopback, multicast, documentation, and mDNS names", () => {
    expect(usableConnectionAddress("127.0.0.1")).toBeUndefined();
    expect(usableConnectionAddress("224.0.0.1")).toBeUndefined();
    expect(usableConnectionAddress("::1")).toBeUndefined();
    expect(usableConnectionAddress("ff02::1")).toBeUndefined();
    expect(usableConnectionAddress("2001:db8::1")).toBeUndefined();
    expect(usableConnectionAddress("device.local")).toBeUndefined();
  });
});

describe("isLanAddress", () => {
  it("recognizes private IPv4, CGNAT, ULA, and link-local IPv6", () => {
    expect(isLanAddress("192.168.1.2")).toBe(true);
    expect(isLanAddress("100.64.1.2")).toBe(true);
    expect(isLanAddress("fd00::1")).toBe(true);
    expect(isLanAddress("fe80::1%en0")).toBe(true);
    expect(isLanAddress("8.8.8.8")).toBe(false);
    expect(isLanAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("ICE candidate address parsing", () => {
  it("extracts host and related addresses from raw candidate SDP", () => {
    expect(
      addressesFromIceCandidateLine(
        "candidate:1 1 UDP 2122260223 192.168.1.20 50000 typ host generation 0",
      ),
    ).toEqual({ address: "192.168.1.20" });
    expect(
      addressesFromIceCandidateLine(
        "candidate:2 1 UDP 1686052607 203.0.113.8 62000 typ srflx raddr 192.168.1.20 rport 50000",
      ),
    ).toEqual({
      address: "203.0.113.8",
      relatedAddress: "192.168.1.20",
    });
  });

  it("recognizes privacy-preserving mDNS host candidates", () => {
    expect(isMdnsCandidateAddress("ABCD-1234.local")).toBe(true);
    expect(isMdnsCandidateAddress("192.168.1.20")).toBe(false);
  });
});

describe("connectionRouteFromCandidates", () => {
  const endpoint = (
    address: string,
    type: RTCIceCandidateType,
    protocol: RTCIceProtocol = "udp",
  ) => ({ address, type, protocol });

  it("classifies LAN, IPv4, and IPv6 direct paths", () => {
    expect(
      connectionRouteFromCandidates(
        endpoint("192.168.1.2", "host"),
        endpoint("192.168.1.3", "host"),
      ).kind,
    ).toBe("lan");
    expect(
      connectionRouteFromCandidates(
        endpoint("203.0.113.10", "srflx"),
        endpoint("198.51.100.20", "srflx"),
      ).kind,
    ).toBe("ipv4");
    expect(
      connectionRouteFromCandidates(
        endpoint("2606:4700::1", "host"),
        endpoint("2400:3200::1", "host"),
      ).kind,
    ).toBe("ipv6");
  });

  it("recognizes a relay pair without assuming it is direct", () => {
    const route = connectionRouteFromCandidates(
      endpoint("203.0.113.10", "relay"),
      endpoint("198.51.100.20", "srflx"),
    );
    expect(route.kind).toBe("relay");
    expect(route.protocol).toBe("udp");
  });

  it("classifies mDNS host pairs as a LAN route", () => {
    expect(
      connectionRouteFromCandidates(
        endpoint("phone-a.local", "host"),
        endpoint("phone-b.local", "host"),
      ).kind,
    ).toBe("lan");
  });

  it("finds the selected pair from WebRTC stats when transport APIs lag", () => {
    const reports = new Map<string, RTCStats>([
      [
        "transport",
        {
          id: "transport",
          timestamp: 1,
          type: "transport",
          selectedCandidatePairId: "pair",
        } as RTCStats,
      ],
      [
        "pair",
        {
          id: "pair",
          timestamp: 1,
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
        } as RTCStats,
      ],
      [
        "local",
        {
          id: "local",
          timestamp: 1,
          type: "local-candidate",
          address: "192.168.1.2",
          candidateType: "host",
          protocol: "udp",
        } as RTCStats,
      ],
      [
        "remote",
        {
          id: "remote",
          timestamp: 1,
          type: "remote-candidate",
          address: "192.168.1.3",
          candidateType: "host",
          protocol: "udp",
        } as RTCStats,
      ],
    ]);

    expect(
      selectedCandidatePairFromStats(
        reports as unknown as RTCStatsReport,
      ),
    ).toEqual({
      local: {
        address: "192.168.1.2",
        type: "host",
        protocol: "udp",
      },
      remote: {
        address: "192.168.1.3",
        type: "host",
        protocol: "udp",
      },
    });
  });

  it("reconciles both peer observations symmetrically", () => {
    const detailed = {
      kind: "ipv4" as const,
      protocol: "udp" as const,
      localAddress: "198.51.100.10",
    };
    const generic = {
      kind: "direct" as const,
      protocol: "udp" as const,
    };
    expect(reconcileConnectionRoutes(detailed, generic)?.kind).toBe(
      "ipv4",
    );
    expect(reconcileConnectionRoutes(generic, detailed)?.kind).toBe(
      "ipv4",
    );

    const relayed = {
      kind: "relay" as const,
      protocol: "udp" as const,
    };
    expect(reconcileConnectionRoutes(detailed, relayed)?.kind).toBe(
      "relay",
    );
    expect(reconcileConnectionRoutes(relayed, detailed)?.kind).toBe(
      "relay",
    );
  });
});
