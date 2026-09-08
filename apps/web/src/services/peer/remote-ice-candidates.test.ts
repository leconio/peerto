import { describe, expect, it } from "vitest";
import { RemoteIceCandidates } from "./remote-ice-candidates";

const sdp = (ufrag: string): RTCSessionDescriptionInit => ({ type: "offer", sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\n` });
const candidate = (ufrag?: string): RTCIceCandidateInit => ({ candidate: "candidate:1 1 udp 1 192.0.2.1 50000 typ host", sdpMid: "0", ...(ufrag ? { usernameFragment: ufrag } : {}) });

describe("remote ICE candidate generations", () => {
  it("queues before SDP and flushes only the matching generation", () => {
    const inbox = new RemoteIceCandidates();
    const first = candidate("first");
    const next = candidate("next");
    expect(inbox.accept(first)).toBe("queued");
    expect(inbox.accept(next)).toBe("queued");
    expect(inbox.update([sdp("first")])).toEqual([first]);
    expect(inbox.update([sdp("next")])).toEqual([next]);
    expect(inbox.accept(first)).toBe("stale");
  });

  it("keeps current and pending generations until the answer commits", () => {
    const inbox = new RemoteIceCandidates();
    inbox.update([sdp("old"), sdp("new")]);
    expect(inbox.accept(candidate("old"))).toBe("ready");
    expect(inbox.accept(candidate("new"))).toBe("ready");
    inbox.update([sdp("new")]);
    expect(inbox.accept(candidate("old"))).toBe("stale");
  });

  it("preserves generation-specific end-of-candidates and legacy candidates", () => {
    const inbox = new RemoteIceCandidates();
    const end = { candidate: "", sdpMid: "0", usernameFragment: "new" };
    inbox.accept(end);
    inbox.accept(candidate());
    expect(inbox.update([sdp("new")])).toEqual([end, candidate()]);
  });

  it("reads a candidate-line ufrag when the optional field is absent", () => {
    const inbox = new RemoteIceCandidates();
    inbox.update([sdp("old")]);
    inbox.update([sdp("new")]);
    expect(inbox.accept({ ...candidate(), candidate: `${candidate().candidate} ufrag old` })).toBe("stale");
  });

  it("bounds pending candidates without evicting the first legitimate generation", () => {
    const inbox = new RemoteIceCandidates();
    for (let i = 0; i < 256; i++) expect(inbox.accept(candidate("first"))).toBe("queued");
    expect(inbox.accept(candidate("unknown"))).toBe("overflow");
    expect(inbox.update([sdp("first")])).toHaveLength(256);
    expect(inbox.accept(candidate("first"))).toBe("ready");
  });
});
