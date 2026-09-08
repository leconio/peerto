import { describe, expect, it } from "vitest";
import { candidateFields, descriptionFields, diagnosticDetail, rtcErrorFields } from "./connection-diagnostics";

describe("redacted connection diagnostics", () => {
  it("does not retain arbitrary server error contents", () => {
    expect(diagnosticDetail("server.DEVICE_PROOF_FAILED")).toBe("server.DEVICE_PROOF_FAILED");
    expect(diagnosticDetail("server.secret-token:private-address")).toBe("server.unknown");
    expect(diagnosticDetail("directConnectionFailed")).toBe("directConnectionFailed");
  });
  it("summarizes SDP without retaining credentials, fingerprints or addresses", () => {
    const result = descriptionFields({ type: "offer", sdp: "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:secret-user\r\na=ice-pwd:secret-pass\r\na=fingerprint:sha-256 SECRET\r\nc=IN IP4 198.51.100.7\r\n" });
    expect(result).toMatchObject({ descriptionType: "offer", mediaSections: 1, hasIceCredentials: true, hasFingerprint: true });
    expect(JSON.stringify(result)).not.toMatch(/secret|SECRET|198\.51/);
  });
  it("summarizes IPv4, IPv6 and mDNS candidates without IPs, ports or ufrags", () => {
    for (const [address, addressFamily] of [["198.51.100.7", "ipv4"], ["2001:db8::7", "ipv6"], ["private.local", "mdns"]]) {
      const result = candidateFields({ candidate: `candidate:1 1 udp 123 ${address} 56789 typ srflx raddr 192.168.1.8 rport 99 ufrag sensitive`, sdpMLineIndex: 0 });
      expect(result).toMatchObject({ candidateType: "srflx", protocol: "udp", addressFamily, hasGeneration: true, mediaIndex: 0 });
      expect(JSON.stringify(result)).not.toMatch(/198\.51|2001:|private|56789|192\.168|sensitive/);
    }
  });
  it("keeps error category and SDP line, never the browser's error message", () => {
    expect(rtcErrorFields(Object.assign(new Error("SDP secret=leaked"), { name: "RTCError", errorDetail: "sdp-syntax-error", sdpLineNumber: 14 })))
      .toEqual({ error: "RTCError", errorDetail: "sdp-syntax-error", sdpLine: 14 });
    expect(rtcErrorFields({ name: "secret", errorDetail: "token" })).toEqual({ error: "UnknownError" });
    expect(rtcErrorFields(null)).toEqual({ error: "UnknownError" });
  });
});
