import { describe, expect, it } from "vitest";
import { resolveInitialLanguage } from "./language";

describe("resolveInitialLanguage", () => {
  it("defaults to English", () => {
    expect(resolveInitialLanguage(null)).toBe("en");
    expect(resolveInitialLanguage("")).toBe("en");
    expect(resolveInitialLanguage("fr")).toBe("en");
  });

  it("keeps a saved language preference", () => {
    expect(resolveInitialLanguage("en")).toBe("en");
    expect(resolveInitialLanguage("zh")).toBe("zh");
  });
});
