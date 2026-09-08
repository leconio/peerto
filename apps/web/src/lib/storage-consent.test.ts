import { describe, expect, it } from "vitest";
import {
  hasStorageConsent,
  storageConsentCookie,
} from "./storage-consent";

describe("storage consent", () => {
  it("accepts only the current consent version", () => {
    expect(
      hasStorageConsent("theme=dark; peerto_storage_consent=v1"),
    ).toBe(true);
    expect(hasStorageConsent("peerto_storage_consent=v0")).toBe(
      false,
    );
    expect(hasStorageConsent("")).toBe(false);
  });

  it("creates a strict first-party cookie", () => {
    expect(storageConsentCookie(true)).toBe(
      "peerto_storage_consent=v1; Max-Age=31536000; Path=/; SameSite=Strict; Secure",
    );
    expect(storageConsentCookie(false)).not.toContain("Secure");
  });
});
