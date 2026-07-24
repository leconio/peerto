import { describe, expect, it } from "vitest";
import { networkEnvironmentState } from "./network-environment";

describe("networkEnvironmentState", () => {
  it("distinguishes current, cached, limited, and offline states", () => {
    expect(networkEnvironmentState(undefined, true, true)).toBe(
      "probing",
    );
    expect(
      networkEnvironmentState(
        {
          addresses: ["198.51.100.10"],
          freshness: "current",
          hasHostCandidate: true,
          hasMaskedLanCandidate: false,
        },
        false,
        true,
      ),
    ).toBe("ready");
    expect(
      networkEnvironmentState(
        {
          addresses: ["198.51.100.10"],
          freshness: "cached",
          hasHostCandidate: false,
          hasMaskedLanCandidate: false,
        },
        false,
        true,
      ),
    ).toBe("cached");
    expect(
      networkEnvironmentState(
        {
          addresses: [],
          freshness: "unavailable",
          hasHostCandidate: true,
          hasMaskedLanCandidate: true,
        },
        false,
        true,
      ),
    ).toBe("limited");
    expect(networkEnvironmentState(undefined, false, false)).toBe(
      "offline",
    );
  });
});
