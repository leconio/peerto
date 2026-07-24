import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { stablePublicKey, type DeviceIdentity } from "@peerto/protocol";
import {
  challengePayload,
  deviceIdForPublicKey,
  verifyChallenge,
  verifyDeviceIdentity,
} from "./device-auth";

describe("device proof", () => {
  it("verifies a P-256 device signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const identity: DeviceIdentity = {
      deviceId: createHash("sha256")
        .update(stablePublicKey(jwk))
        .digest("base64url"),
      name: "Test device",
      publicKey: {
        crv: "P-256",
        kty: "EC",
        x: jwk.x!,
        y: jwk.y!,
      },
    };
    const signature = sign(
      "sha256",
      challengePayload("123456", "challenge"),
      { key: privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");

    expect(deviceIdForPublicKey(identity.publicKey)).toBe(
      identity.deviceId,
    );
    expect(verifyDeviceIdentity(identity)).toBe(true);
    expect(
      verifyChallenge(identity, "123456", "challenge", signature),
    ).toBe(true);
    expect(
      verifyChallenge(identity, "654321", "challenge", signature),
    ).toBe(false);
  });
});
