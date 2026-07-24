import { describe, expect, it } from "vitest";
import {
  createRoomRequestSchema,
  dataMessageSchema,
  normalizeCode,
  rtcSignalSchema,
  stablePublicKey,
} from "./index";

describe("protocol validation", () => {
  const publicKey = {
    crv: "P-256" as const,
    ext: true,
    key_ops: ["verify"],
    kty: "EC" as const,
    x: "x-value",
    y: "y-value",
  };

  it("accepts a valid room request", () => {
    expect(
      createRoomRequestSchema.safeParse({
        host: { deviceId: "device-id-with-enough-characters", name: "Mac", publicKey },
      }).success,
    ).toBe(true);
  });

  it("rejects legacy address fields instead of migrating them", () => {
    expect(
      createRoomRequestSchema.safeParse({
        host: {
          deviceId: "device-id-with-enough-characters",
          name: "Mac",
          publicKey,
        },
        addresses: ["192.0.2.1"],
      }).success,
    ).toBe(false);
  });

  it("rejects blank chat messages", () => {
    expect(
      dataMessageSchema.safeParse({
        type: "chat",
        id: crypto.randomUUID(),
        text: "",
        createdAt: Date.now(),
      }).success,
    ).toBe(false);
  });

  it("accepts replies and pinned message updates", () => {
    const messageId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    expect(
      dataMessageSchema.safeParse({
        type: "chat",
        id: crypto.randomUUID(),
        text: "reply",
        createdAt: Date.now(),
        replyTo: {
          messageId,
          senderId: "device-id-with-enough-characters",
          kind: "text",
          preview: "original message",
        },
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "message_pin",
        messageId,
        pinnedAt: Date.now(),
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "message_pin",
        messageId,
        pinnedAt: null,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "message_delete",
        requestId,
        messageId,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "message_delete_result",
        requestId,
        messageId,
        deleted: true,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "conversation_delete",
        requestId,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "conversation_delete_result",
        requestId,
        deleted: true,
      }).success,
    ).toBe(true);
  });

  it("requires the current file protocol and accepts completion receipts", () => {
    const transferId = crypto.randomUUID();
    expect(
      dataMessageSchema.safeParse({
        type: "peer_hello",
        device: {
          deviceId: "device-id-with-enough-characters",
          name: "Phone",
          publicKey,
        },
        fileChunkProtocol: 2,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "peer_hello",
        device: {
          deviceId: "device-id-with-enough-characters",
          name: "Old Phone",
          publicKey,
        },
      }).success,
    ).toBe(false);
    expect(
      dataMessageSchema.safeParse({
        type: "file_complete",
        transferId,
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "file_cancel",
        messageId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "connection_route",
        kind: "ipv4",
        protocol: "udp",
      }).success,
    ).toBe(true);
  });

  it("normalizes a six digit code", () => {
    expect(normalizeCode("12 3a4567")).toBe("123456");
  });

  it("accepts an ICE restart request", () => {
    expect(
      rtcSignalSchema.safeParse({ kind: "restart_request" }).success,
    ).toBe(true);
    expect(
      dataMessageSchema.safeParse({
        type: "rtc_signal",
        signal: { kind: "restart_request" },
      }).success,
    ).toBe(true);
  });

  it("accepts a full peer reconnect request", () => {
    expect(
      rtcSignalSchema.safeParse({ kind: "reconnect_request" }).success,
    ).toBe(true);
  });

  it("uses only key material for the stable representation", () => {
    expect(stablePublicKey(publicKey)).toBe(
      '{"crv":"P-256","kty":"EC","x":"x-value","y":"y-value"}',
    );
  });
});
