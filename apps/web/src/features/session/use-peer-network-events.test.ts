import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeerClient } from "../../services/peer";
import { updatePeerClientsForNetwork, usePeerNetworkEvents } from "./use-peer-network-events";

const effects = vi.hoisted(() => [] as EffectCallback[]);
vi.mock("react", () => ({ useEffect: (effect: EffectCallback) => effects.push(effect) }));

afterEach(() => {
  effects.length = 0;
  vi.unstubAllGlobals();
});

describe("updatePeerClientsForNetwork", () => {
  it("does not launch address probes when the network returns", () => {
    const pairing = { setNetworkAvailable: vi.fn() };
    const firstSession = { setNetworkAvailable: vi.fn() };
    const secondSession = { setNetworkAvailable: vi.fn() };

    updatePeerClientsForNetwork(true, pairing, [
      firstSession,
      secondSession,
    ]);

    expect(pairing.setNetworkAvailable).toHaveBeenCalledWith(true, false);
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

    expect(pairing.setNetworkAvailable).toHaveBeenCalledWith(false, false);
    expect(session.setNetworkAvailable).toHaveBeenCalledWith(
      false,
      false,
    );
  });

  it("probes all retained sessions only on visible online resumes and removes listeners", () => {
    const windowEvents = new EventTarget();
    const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const navigatorState = { onLine: true };
    vi.stubGlobal("window", windowEvents);
    vi.stubGlobal("document", documentEvents);
    vi.stubGlobal("navigator", navigatorState);
    const pairing = { checkConnectionAfterResume: vi.fn() };
    const session = { checkConnectionAfterResume: vi.fn() };
    usePeerNetworkEvents(
      pairing as unknown as PeerClient,
      { current: new Map([["peer", session as unknown as PeerClient]]) },
    );
    const cleanup = effects[0]!();
    try {
      windowEvents.dispatchEvent(new Event("pageshow"));
      expect(pairing.checkConnectionAfterResume).toHaveBeenCalledOnce();
      expect(session.checkConnectionAfterResume).toHaveBeenCalledOnce();
      documentEvents.visibilityState = "hidden";
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      documentEvents.visibilityState = "visible";
      navigatorState.onLine = false;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      expect(session.checkConnectionAfterResume).toHaveBeenCalledOnce();
      navigatorState.onLine = true;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      expect(session.checkConnectionAfterResume).toHaveBeenCalledTimes(2);
    } finally {
      if (cleanup) cleanup();
    }
    windowEvents.dispatchEvent(new Event("pageshow"));
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(session.checkConnectionAfterResume).toHaveBeenCalledTimes(2);
  });
});
