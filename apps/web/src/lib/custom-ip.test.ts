import { describe, expect, it } from "vitest";
import {
  customIpIceCandidate,
  customIpSessionDescription,
  normalizeCustomIp,
} from "./custom-ip";

describe("normalizeCustomIp", () => {
  it("normalizes IPv4 and IPv6 addresses", () => {
    expect(normalizeCustomIp(" 192.168.001.020 ")).toBe(
      "192.168.1.20",
    );
    expect(normalizeCustomIp("[2001:0db8::1]")).toBe("2001:db8::1");
  });

  it("rejects ports, prefixes, link-local IPv6, and invalid addresses", () => {
    expect(normalizeCustomIp("192.168.1.1:9000")).toBeUndefined();
    expect(normalizeCustomIp("10.0.0.1/24")).toBeUndefined();
    expect(normalizeCustomIp("fe80::1%en0")).toBeUndefined();
    expect(normalizeCustomIp("fe80::1")).toBeUndefined();
    expect(normalizeCustomIp("300.1.1.1")).toBeUndefined();
  });
});

describe("custom IP ICE rewriting", () => {
  const host =
    "candidate:1 1 UDP 2122260223 device.local 52705 typ host generation 0";
  const serverReflexive =
    "candidate:2 1 UDP 1686052607 203.0.113.2 62000 typ srflx raddr 0.0.0.0 rport 0";

  it("rewrites host candidates and preserves their port and metadata", () => {
    expect(
      customIpIceCandidate({ candidate: host, sdpMid: "0" }, "10.0.0.8"),
    ).toEqual({
      candidate:
        "candidate:1 1 UDP 2122260223 10.0.0.8 52705 typ host generation 0",
      sdpMid: "0",
    });
  });

  it("drops non-host candidates in custom IP mode", () => {
    expect(
      customIpIceCandidate(
        { candidate: serverReflexive },
        "10.0.0.8",
      ),
    ).toBeUndefined();
  });

  it("rewrites inline SDP candidates and removes non-host candidates", () => {
    const result = customIpSessionDescription(
      {
        type: "offer",
        sdp: `v=0\r\na=${host}\r\na=${serverReflexive}\r\n`,
      },
      "fd00::8",
    );
    expect(result.sdp).toContain(
      "a=candidate:1 1 UDP 2122260223 fd00::8 52705 typ host",
    );
    expect(result.sdp).not.toContain("typ srflx");
  });
});
