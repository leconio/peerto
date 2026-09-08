// Bound the entire response, including a body that stalls after HTTP headers.
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  let rejectAborted: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    return await Promise.race([
      aborted,
      Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(url, { ...init, signal: controller.signal });
        const payload: unknown = await response.json();
        return { response, payload };
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
    if (rejectAborted) {
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }
}
