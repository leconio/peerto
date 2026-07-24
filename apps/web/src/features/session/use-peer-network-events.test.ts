import { describe, expect, it, vi } from "vitest";
import { updatePeerClientsForNetwork } from "./use-peer-network-events";

describe("updatePeerClientsForNetwork", () => {
  it("probes only with the pairing client when the network returns", () => {
    const pairing = { setNetworkAvailable: vi.fn() };
    const firstSession = { setNetworkAvailable: vi.fn() };
    const secondSession = { setNetworkAvailable: vi.fn() };

    updatePeerClientsForNetwork(true, pairing, [
      firstSession,
      secondSession,
    ]);

    expect(pairing.setNetworkAvailable).toHaveBeenCalledWith(true);
    expect(firstSession.setNetworkAvailable).toHaveBeenCalledWith(
      true,
      false,
    );
    expect(secondSession.setNetworkAvailable).toHaveBeenCalledWith(
      true,
      false,
    );
  });

  it("marks every client offline without starting a probe", () => {
    const pairing = { setNetworkAvailable: vi.fn() };
    const session = { setNetworkAvailable: vi.fn() };

    updatePeerClientsForNetwork(false, pairing, [session]);

    expect(pairing.setNetworkAvailable).toHaveBeenCalledWith(false);
    expect(session.setNetworkAvailable).toHaveBeenCalledWith(
      false,
      undefined,
    );
  });
});
