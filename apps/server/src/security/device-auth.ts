import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey,
  verify,
} from "node:crypto";
import { stablePublicKey, type DeviceIdentity } from "@peerto/protocol";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function safeTokenEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function deviceIdForPublicKey(
  publicKey: DeviceIdentity["publicKey"],
): string {
  return createHash("sha256")
    .update(stablePublicKey(publicKey))
    .digest("base64url");
}

export function verifyDeviceIdentity(device: DeviceIdentity): boolean {
  return device.deviceId === deviceIdForPublicKey(device.publicKey);
}

export function createChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export function challengePayload(code: string, challenge: string): Buffer {
  return Buffer.from(`peerto:${code}:${challenge}`, "utf8");
}

export function verifyChallenge(
  device: DeviceIdentity,
  code: string,
  challenge: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: device.publicKey as JsonWebKey,
      format: "jwk",
    });
    return verify(
      "sha256",
      challengePayload(code, challenge),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
