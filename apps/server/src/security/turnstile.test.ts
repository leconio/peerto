import { describe, expect, it, vi } from "vitest";
import { CloudflareTurnstileVerifier } from "./turnstile";

describe("CloudflareTurnstileVerifier", () => {
  it("accepts only the expected action and hostname", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: "create_room",
          hostname: "peerto.example.com",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const verifier = new CloudflareTurnstileVerifier({
      secretKey: "secret",
      allowedHostnames: ["peerto.example.com"],
      fetchImpl,
    });

    await expect(
      verifier.verify({
        token: "token",
        remoteIp: "203.0.113.10",
        action: "create_room",
      }),
    ).resolves.toBe(true);

    const request = fetchImpl.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(String(request?.[1]?.body)).toContain("secret=secret");
    expect(String(request?.[1]?.body)).toContain(
      "remoteip=203.0.113.10",
    );
  });

  it("rejects a successful response for another hostname", async () => {
    const verifier = new CloudflareTurnstileVerifier({
      secretKey: "secret",
      allowedHostnames: ["peerto.example.com"],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: "create_room",
            hostname: "attacker.example",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    await expect(
      verifier.verify({
        token: "token",
        remoteIp: "203.0.113.10",
        action: "create_room",
      }),
    ).resolves.toBe(false);
  });
});
