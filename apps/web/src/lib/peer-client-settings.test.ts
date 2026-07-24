import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ACTIVE_PEER_CLIENTS,
  normalizeMaxActivePeerClients,
} from "./peer-client-settings";

describe("normalizeMaxActivePeerClients", () => {
  it("uses four by default and clamps unsafe values", () => {
    expect(DEFAULT_MAX_ACTIVE_PEER_CLIENTS).toBe(4);
    expect(normalizeMaxActivePeerClients(Number.NaN)).toBe(4);
    expect(normalizeMaxActivePeerClients(0)).toBe(1);
    expect(normalizeMaxActivePeerClients(8.9)).toBe(8);
    expect(normalizeMaxActivePeerClients(100)).toBe(32);
  });
});
