import { describe, expect, it } from "vitest";
import {
  hasTurnServer,
  relayUpgradeDelay,
  shouldScheduleRelayUpgrade,
} from "./relay-upgrade";

const turnServers: RTCIceServer[] = [
  { urls: "stun:stun.example.com:3478" },
  { urls: "turn:turn.example.com:3478" },
];

describe("relay upgrade policy", () => {
  it("backs off from 15 seconds to 30 minutes", () => {
    expect(relayUpgradeDelay(0)).toBe(15_000);
    expect(relayUpgradeDelay(1)).toBe(60_000);
    expect(relayUpgradeDelay(2)).toBe(5 * 60_000);
    expect(relayUpgradeDelay(20)).toBe(30 * 60_000);
  });

  it("recognizes TURN and TURNS URLs", () => {
    expect(hasTurnServer(turnServers)).toBe(true);
    expect(
      hasTurnServer([{ urls: "turns:turn.example.com:5349" }]),
    ).toBe(true);
    expect(
      hasTurnServer([{ urls: "stun:stun.example.com:3478" }]),
    ).toBe(false);
  });

  it("runs only for an online host using a relay in automatic mode", () => {
    const base = {
      role: "host" as const,
      online: true,
      relayOnly: false,
      route: { kind: "relay" as const },
      iceServers: turnServers,
    };
    expect(shouldScheduleRelayUpgrade(base)).toBe(true);
    expect(
      shouldScheduleRelayUpgrade({ ...base, relayOnly: true }),
    ).toBe(false);
    expect(
      shouldScheduleRelayUpgrade({ ...base, role: "guest" }),
    ).toBe(false);
    expect(
      shouldScheduleRelayUpgrade({
        ...base,
        customPeerIp: "192.168.1.20",
      }),
    ).toBe(false);
    expect(
      shouldScheduleRelayUpgrade({
        ...base,
        route: { kind: "ipv4" },
      }),
    ).toBe(false);
  });
});
