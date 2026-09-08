import { z } from "zod";

export const publicKeySchema = z.object({
  crv: z.literal("P-256"),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional(),
  kty: z.literal("EC"),
  x: z.string().min(1),
  y: z.string().min(1),
});

export const deviceIdentitySchema = z.object({
  deviceId: z.string().min(20).max(128),
  name: z.string().trim().min(1).max(64),
  publicKey: publicKeySchema,
});

export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export const createRoomRequestSchema = z.object({
  host: deviceIdentitySchema,
  turnstileToken: z.string().min(1).max(2_048).optional(),
}).strict();

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

export const createRoomResponseSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.number().int().positive(),
  hostToken: z.string().min(32),
  shareToken: z.string().min(32),
  connectionToken: z.string().min(32),
});

export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export const reconnectRoomRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  device: deviceIdentitySchema,
  peerDeviceId: z.string().min(20).max(128),
  connectionToken: z.string().min(32).max(256),
}).strict();

export type ReconnectRoomRequest = z.infer<
  typeof reconnectRoomRequestSchema
>;

export const reconnectRoomResponseSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.number().int().positive(),
  role: z.enum(["host", "guest"]),
});

export type ReconnectRoomResponse = z.infer<
  typeof reconnectRoomResponseSchema
>;

export const rendezvousInfoSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  token: z.string().min(32).max(256),
  role: z.enum(["host", "guest"]),
});

export type RendezvousInfo = z.infer<typeof rendezvousInfoSchema>;

export const rtcSignalSchema = z.union([
  z.object({
    kind: z.literal("description"),
    description: z.object({
      type: z.enum(["offer", "answer", "pranswer", "rollback"]),
      sdp: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal("candidate"),
    candidate: z.object({
      candidate: z.string(),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }),
  }),
  z.object({
    kind: z.literal("restart_request"),
  }),
]);

export type RtcSignal = z.infer<typeof rtcSignalSchema>;

export const wsSessionInitSchema = z.object({
  type: z.literal("session_init"),
  token: z.string().min(32).max(256).optional(),
  connectionToken: z.string().min(32).max(256).optional(),
  deviceId: z.string().min(20).max(128).optional(),
  peerDeviceId: z.string().min(20).max(128).optional(),
  recoveryDevice: deviceIdentitySchema.optional(),
}).strict();

export type WsSessionInit = z.infer<typeof wsSessionInitSchema>;

export const clientWsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticate"),
    device: deviceIdentitySchema,
    signature: z.string().min(1),
    shareToken: z.string().min(32).max(256).optional(),
    connectionToken: z.string().min(32).max(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("accept_peer"),
    deviceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("reject_peer"),
    deviceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("signal"),
    sessionId: z.string().min(1).max(128).optional(),
    signal: rtcSignalSchema,
  }),
  z.object({
    type: z.literal("connected"),
    sessionId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("signaling_stable"),
    sessionId: z.string().min(1).max(128).optional(),
  }),
]);

export type ClientWsMessage = z.infer<typeof clientWsMessageSchema>;

export const serverWsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room_ready"),
    code: z.string(),
    expiresAt: z.number(),
  }),
  z.object({
    type: z.literal("challenge"),
    challenge: z.string(),
  }),
  z.object({
    type: z.literal("join_request"),
    device: deviceIdentitySchema,
  }),
  z.object({
    type: z.literal("peer_accepted"),
    sessionId: z.string().min(1).max(128).optional(),
    peer: deviceIdentitySchema,
    rendezvous: rendezvousInfoSchema,
  }),
  z.object({
    type: z.literal("peer_rejected"),
  }),
  z.object({
    type: z.literal("signal"),
    sessionId: z.string().min(1).max(128).optional(),
    signal: rtcSignalSchema,
  }),
  z.object({
    type: z.literal("room_consumed"),
  }),
  z.object({
    type: z.literal("room_closed"),
    reason: z.enum([
      "expired",
      "host_offline",
      "ip_changed",
      "invalid_code",
      "replaced",
    ]),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type ServerWsMessage = z.infer<typeof serverWsMessageSchema>;

export const replyReferenceSchema = z.object({
  messageId: z.string().uuid(),
  senderId: z.string().min(1).max(128),
  kind: z.enum(["text", "file"]),
  preview: z.string().min(1).max(500),
});

export type ReplyReference = z.infer<typeof replyReferenceSchema>;

export const dataMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat"),
    id: z.string().uuid(),
    text: z.string().min(1).max(20_000),
    createdAt: z.number().int().positive(),
    replyTo: replyReferenceSchema.optional(),
  }),
  z.object({
    type: z.literal("ack"),
    id: z.string().uuid(),
  }),
  z.object({
    type: z.literal("peer_hello"),
    device: deviceIdentitySchema,
    fileChunkProtocol: z.literal(2),
  }).strict(),
  z.object({
    type: z.literal("connection_route"),
    kind: z.enum(["direct", "lan", "ipv4", "ipv6", "relay"]),
    protocol: z.enum(["udp", "tcp"]).optional(),
  }).strict(),
  z.object({
    type: z.literal("rtc_signal"),
    signal: rtcSignalSchema,
  }).strict(),
  z.object({
    type: z.literal("ping"),
    at: z.number(),
  }),
  z.object({
    type: z.literal("pong"),
    at: z.number(),
  }),
  z.object({
    type: z.literal("file_offer"),
    transferId: z.string().uuid(),
    messageId: z.string().uuid(),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    mime: z.string().max(255),
    createdAt: z.number().int().positive(),
    replyTo: replyReferenceSchema.optional(),
  }),
  z.object({
    type: z.literal("file_accept"),
    transferId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("file_reject"),
    transferId: z.string().uuid(),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("file_end"),
    transferId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("file_complete"),
    transferId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("file_chunk_ack"),
    transferId: z.string().uuid(),
    received: z.number().int().nonnegative(),
    nextSequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("file_cancel"),
    messageId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("message_pin"),
    messageId: z.string().uuid(),
    pinnedAt: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal("message_delete"),
    requestId: z.string().uuid(),
    messageId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("message_delete_result"),
    requestId: z.string().uuid(),
    messageId: z.string().uuid(),
    deleted: z.boolean(),
  }),
  z.object({
    type: z.literal("conversation_delete"),
    requestId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("conversation_delete_result"),
    requestId: z.string().uuid(),
    deleted: z.boolean(),
  }).strict(),
]);

export type DataMessage = z.infer<typeof dataMessageSchema>;

export interface PublicKeyLike {
  crv?: string;
  kty?: string;
  x?: string;
  y?: string;
}

export function stablePublicKey(publicKey: PublicKeyLike): string {
  return JSON.stringify({
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  });
}

export function normalizeCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}
