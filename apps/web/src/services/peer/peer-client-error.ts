export class PeerClientError extends Error {
  constructor(
    readonly code: string,
    readonly values?: Record<string, string | number>,
  ) {
    super(code);
    this.name = "PeerClientError";
  }
}
