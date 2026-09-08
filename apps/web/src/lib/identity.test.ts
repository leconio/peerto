import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readKeyPair, storeKeyPairIfAbsent } from "./database";
import { loadIdentity } from "./identity";

vi.mock("./database", () => ({ readKeyPair: vi.fn(), storeKeyPairIfAbsent: vi.fn() }));

describe("device identity initialization", () => {
  beforeEach(() => {
    vi.mocked(readKeyPair).mockReset().mockResolvedValue(undefined);
    vi.mocked(storeKeyPairIfAbsent).mockReset().mockImplementation(async key => key);
  });
  afterEach(() => vi.restoreAllMocks());

  it("coalesces concurrent first loads (including StrictMode) into one identity", async () => {
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    const identities = await Promise.all(Array.from({ length: 5 }, () => loadIdentity("QR Phone")));
    expect(generate).toHaveBeenCalledOnce();
    expect(storeKeyPairIfAbsent).toHaveBeenCalledOnce();
    expect(new Set(identities.map(identity => identity.device.deviceId)).size).toBe(1);
    expect(identities.every(identity => identity.device.name === "QR Phone")).toBe(true);
  });

  it("uses the identity that won an atomic store race in another tab", async () => {
    const winner = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    vi.mocked(storeKeyPairIfAbsent).mockResolvedValueOnce(winner);
    const initial = await loadIdentity("Phone");
    expect(initial.keyPair).toBe(winner);
    vi.mocked(readKeyPair).mockResolvedValueOnce(winner);
    const reopened = await loadIdentity("Renamed phone");
    expect(reopened.device.deviceId).toBe(initial.device.deviceId);
    expect(reopened.device.name).toBe("Renamed phone");
    expect(storeKeyPairIfAbsent).toHaveBeenCalledOnce();
  });

  it("can retry initialization after a storage error", async () => {
    vi.mocked(readKeyPair).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(loadIdentity("Phone")).rejects.toThrow("storage unavailable");
    await expect(loadIdentity("Phone")).resolves.toMatchObject({ device: { name: "Phone" } });
  });
});
