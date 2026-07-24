import { randomUUID } from "node:crypto";
import { z } from "zod";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export interface TurnstileVerification {
  token: string;
  remoteIp: string;
  action: string;
}

export interface TurnstileVerifier {
  verify(input: TurnstileVerification): Promise<boolean>;
}

export interface CloudflareTurnstileVerifierOptions {
  secretKey: string;
  allowedHostnames: string[];
  fetchImpl?: typeof fetch;
}

export class CloudflareTurnstileVerifier
  implements TurnstileVerifier
{
  private readonly allowedHostnames: Set<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: CloudflareTurnstileVerifierOptions,
  ) {
    this.allowedHostnames = new Set(
      options.allowedHostnames.map((hostname) =>
        hostname.toLowerCase(),
      ),
    );
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async verify(input: TurnstileVerification): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      VERIFY_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      const body = new URLSearchParams({
        secret: this.options.secretKey,
        response: input.token,
        remoteip: input.remoteIp,
        idempotency_key: randomUUID(),
      });
      const response = await this.fetchImpl(SITEVERIFY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const parsed = siteverifyResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success || !parsed.data.success) return false;
      const hostname = parsed.data.hostname?.toLowerCase();
      return (
        parsed.data.action === input.action &&
        Boolean(hostname && this.allowedHostnames.has(hostname))
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
