import { describe, expect, it } from "vitest";
import {
  iceServerSettingsFromRtc,
  normalizeIceServerSettings,
  rtcIceServersFromSettings,
  validateIceServerSettings,
} from "./ice-settings";

describe("ICE server settings", () => {
  it("extracts multiple TURN URLs with shared credentials", () => {
    expect(
      iceServerSettingsFromRtc([
        {
          urls: [
            "stun:one.example.com:3478",
            "stun:two.example.com:3478",
          ],
        },
        {
          urls: "turn:relay.example.com:3478?transport=udp",
          username: "peer",
          credential: "secret",
        },
        {
          urls: "turns:relay.example.com:5349?transport=tcp",
          username: "peer",
          credential: "secret",
        },
      ]),
    ).toEqual({
      stunUrls: [
        "stun:one.example.com:3478",
        "stun:two.example.com:3478",
      ],
      turn: {
        url:
          "turn:relay.example.com:3478?transport=udp\n" +
          "turns:relay.example.com:5349?transport=tcp",
        username: "peer",
        credential: "secret",
      },
      relayOnly: false,
    });
  });

  it("normalizes duplicates and builds browser ICE servers", () => {
    const settings = normalizeIceServerSettings({
      stunUrls: [
        " stun:one.example.com:3478 ",
        "stun:one.example.com:3478",
      ],
      turn: {
        url:
          " turns:relay.example.com:5349 \n" +
          "turns:relay.example.com:5349\n" +
          "turn:backup.example.com:3478?transport=udp",
        username: " peer ",
        credential: "secret",
      },
    });

    expect(rtcIceServersFromSettings(settings)).toEqual([
      { urls: ["stun:one.example.com:3478"] },
      {
        urls: [
          "turns:relay.example.com:5349",
          "turn:backup.example.com:3478?transport=udp",
        ],
        username: "peer",
        credential: "secret",
      },
    ]);
  });

  it("rejects mismatched schemes and an empty configuration", () => {
    expect(
      validateIceServerSettings({
        stunUrls: ["https://stun.example.com"],
        turn: { url: "", username: "", credential: "" },
      }),
    ).toBe("INVALID_STUN_URL");
    expect(
      validateIceServerSettings({
        stunUrls: [],
        turn: {
          url: "stun:relay.example.com",
          username: "",
          credential: "",
        },
      }),
    ).toBe("INVALID_TURN_URL");
    expect(
      validateIceServerSettings({
        stunUrls: [],
        turn: {
          url:
            "turn:relay.example.com:3478\nhttps://invalid.example.com",
          username: "",
          credential: "",
        },
      }),
    ).toBe("INVALID_TURN_URL");
    expect(
      validateIceServerSettings({
        stunUrls: [],
        turn: { url: "", username: "", credential: "" },
      }),
    ).toBe("NO_ICE_SERVERS");
    expect(
      validateIceServerSettings({
        stunUrls: ["stun:one.example.com:3478"],
        turn: { url: "", username: "", credential: "" },
        relayOnly: true,
      }),
    ).toBe("RELAY_ONLY_REQUIRES_TURN");
  });

});
