/** Release signaling only after stable ICE gathering and a fresh P2P round trip. */
export class SignalingHandover {
  private timer: number | undefined;
  private probe: number | undefined;
  released = false;

  constructor(private readonly actions: {
    ready: () => boolean;
    nextNonce: () => number;
    ping: (nonce: number) => boolean;
    release: () => void;
  }) {}

  update(): void {
    if (!this.actions.ready()) { this.cancel(); return; }
    if (this.released || this.timer !== undefined || this.probe !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (!this.actions.ready()) return;
      const nonce = this.actions.nextNonce();
      this.probe = nonce;
      this.timer = window.setTimeout(() => this.cancel(), 5_000);
      if (!this.actions.ping(nonce)) this.cancel();
    }, 3_000);
  }

  pong(nonce: number): void {
    if (this.probe !== nonce || !this.actions.ready()) return;
    this.cancel();
    this.released = true;
    this.actions.release();
  }

  cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.probe = undefined;
  }

  reset(): void { this.cancel(); this.released = false; }
}
