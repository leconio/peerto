import { describe, expect, it } from "vitest";
import { directConnectionFailureCode } from "./direct-connection-failure";

describe("directConnectionFailureCode", () => {
  it("does not suggest TURN when custom IP mode disabled ICE servers", () => {
    expect(directConnectionFailureCode("192.168.1.20")).toBe(
      "customIpConnectionFailed",
    );
    expect(directConnectionFailureCode(undefined)).toBe(
      "directConnectionFailed",
    );
  });
});
