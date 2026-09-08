const MAX_PENDING_CANDIDATES = 256;

function candidateGeneration(candidate: RTCIceCandidateInit): string | undefined {
  return candidate.usernameFragment || /(?:^|\s)ufrag\s+(\S+)/.exec(candidate.candidate || "")?.[1];
}

// One inbox per RTCPeerConnection. Candidates for a future SDP may arrive
// before it; candidates for a retired ICE generation must never poison it.
export class RemoteIceCandidates {
  private pending: RTCIceCandidateInit[] = [];
  private active = new Set<string>();
  private retired = new Set<string>();
  private hasDescription = false;

  update(descriptions: (RTCSessionDescriptionInit | null | undefined)[]): RTCIceCandidateInit[] {
    this.hasDescription = descriptions.some(Boolean);
    const next = new Set(descriptions.flatMap(description =>
      [...(description?.sdp || "").matchAll(/^a=ice-ufrag:(\S+)/gm)].map(match => match[1]!),
    ));
    for (const generation of this.active) {
      if (!next.has(generation)) this.retired.add(generation);
    }
    // History and out-of-order signaling are bounded for long-running peers.
    while (this.retired.size > 16) this.retired.delete(this.retired.values().next().value!);
    this.active = next;
    const pending = this.pending;
    this.pending = [];
    return pending.filter(candidate => this.accept(candidate) === "ready");
  }

  accept(candidate: RTCIceCandidateInit): "ready" | "queued" | "stale" | "overflow" {
    const generation = candidateGeneration(candidate);
    if (generation && this.retired.has(generation) && !this.active.has(generation)) return "stale";
    if (this.hasDescription && (!generation || this.active.has(generation))) return "ready";
    if (this.pending.length >= MAX_PENDING_CANDIDATES) return "overflow";
    this.pending.push(candidate);
    return "queued";
  }
}
