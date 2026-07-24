import { describe, expect, it } from "vitest";
import { rtcConfiguration } from "./rtc-config";

describe("rtcConfiguration", () => {
  it("lets standard ICE prefer direct candidates and use TURN as fallback", () => {
    const iceServers: RTCIceServer[] = [
      { urls: "stun:stun.example.com:3478" },
      {
        urls: "turn:turn.example.com:3478?transport=udp",
        username: "user",
        credential: "password",
      },
    ];

    expect(rtcConfiguration(iceServers)).toEqual({
      iceServers,
      iceTransportPolicy: "all",
    });
  });

  it("can require TURN relay candidates through the standard policy", () => {
    const iceServers: RTCIceServer[] = [
      {
        urls: "turn:turn.example.com:3478?transport=udp",
        username: "user",
        credential: "password",
      },
    ];

    expect(rtcConfiguration(iceServers, true)).toEqual({
      iceServers,
      iceTransportPolicy: "relay",
    });
  });
});
