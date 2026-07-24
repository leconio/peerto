export const RECONNECT_ATTEMPT_TIMEOUT_MS = 15_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

export function reconnectBackoffDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(
    1_000 * 2 ** Math.min(normalizedAttempt - 1, 30),
    RECONNECT_MAX_DELAY_MS,
  );
}
