import {
  stablePublicKey,
  type DeviceIdentity,
} from "@peerto/protocol";
import { readKeyPair, writeKeyPair } from "./database";

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = Array.from(new Uint8Array(bytes), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getOrCreateKeyPair(): Promise<CryptoKeyPair> {
  const existing = await readKeyPair();
  if (existing) return existing;

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign", "verify"],
  );
  await writeKeyPair(keyPair);
  return keyPair;
}

export interface LocalIdentity {
  device: DeviceIdentity;
  keyPair: CryptoKeyPair;
}

export async function loadIdentity(name: string): Promise<LocalIdentity> {
  const keyPair = await getOrCreateKeyPair();
  const publicKey = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stablePublicKey(publicKey)),
  );
  return {
    keyPair,
    device: {
      deviceId: toBase64Url(digest),
      name: name.trim().slice(0, 64) || "Peerto",
      publicKey: {
        crv: "P-256",
        ext: publicKey.ext,
        key_ops: publicKey.key_ops,
        kty: "EC",
        x: publicKey.x!,
        y: publicKey.y!,
      },
    },
  };
}

export async function signChallenge(
  privateKey: CryptoKey,
  code: string,
  challenge: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`peerto:${code}:${challenge}`),
  );
  return toBase64Url(signature);
}
