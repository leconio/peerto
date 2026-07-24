import { describe, expect, it } from "vitest";
import { readConfig } from "./app-config";

describe("readConfig", () => {
  it("keeps Turnstile disabled when its keys are empty", () => {
    const config = readConfig({
      TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
      TURNSTILE_ALLOWED_HOSTNAMES: "",
    });

    expect(config.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(config.TURNSTILE_SECRET_KEY).toBeUndefined();
    expect(config.TURNSTILE_ALLOWED_HOSTNAMES).toEqual([]);
  });

  it("requires a complete Turnstile configuration", () => {
    expect(() =>
      readConfig({
        TURNSTILE_SITE_KEY: "site-key",
      }),
    ).toThrow();
    expect(() =>
      readConfig({
        TURNSTILE_SITE_KEY: "site-key",
        TURNSTILE_SECRET_KEY: "secret-key",
      }),
    ).toThrow();
  });

  it("normalizes allowed Turnstile hostnames", () => {
    const config = readConfig({
      TURNSTILE_SITE_KEY: "site-key",
      TURNSTILE_SECRET_KEY: "secret-key",
      TURNSTILE_ALLOWED_HOSTNAMES:
        " Peerto.Example.com,localhost ",
    });

    expect(config.TURNSTILE_ALLOWED_HOSTNAMES).toEqual([
      "peerto.example.com",
      "localhost",
    ]);
  });
});
