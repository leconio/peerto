import type {
  DeviceIdentity,
  ReplyReference,
  RendezvousInfo,
} from "@peerto/protocol";
import type { ConnectionRoute } from "../../lib/network";

export type ConnectionStatus =
  | "offline"
  | "network_offline"
  | "signaling"
  | "waiting"
  | "authenticating"
  | "connecting"
  | "online"
  | "reconnecting"
  | "failed";

export type RuntimeCode =
  | "ready"
  | "networkOffline"
  | "networkRestored"
  | "generatingCode"
  | "waitingForPeer"
  | "waitingForKnownPeer"
  | "codeReady"
  | "validatingCode"
  | "validatingIdentity"
  | "establishingP2P"
  | "negotiatingP2P"
  | "peerOffline"
  | "heartbeatTimeout"
  | "signalingUnavailable"
  | "signalingDisconnected"
  | "invalidServerMessage"
  | "incompatibleServerMessage"
  | "peerRejected"
  | "peerIdentityMismatch"
  | "codeExpired"
  | "hostOffline"
  | "hostIpChanged"
  | "invalidCode"
  | "connectionReplaced"
  | "directConnectionFailed"
  | "customIpConnectionFailed"
  | "connectionInterrupted"
  | "fileRejected"
  | "fileChannelClosed"
  | "fileSendFailed"
  | "peerFileWriteFailed"
  | "fileWriteFailed"
  | `server.${string}`;

export interface ApiConfig {
  iceServers: RTCIceServer[];
  maxFileBytes: number;
  roomTtlSeconds: number;
  turnstileSiteKey?: string;
  relayOnly?: boolean;
}

export interface RoomInfo {
  code: string;
  expiresAt: number;
  shareToken: string;
}

export interface PeerReconnectTarget {
  deviceId: string;
  code: string;
  token: string;
  customIp?: string;
}

export interface FileOffer {
  transferId: string;
  messageId: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
  replyTo?: ReplyReference;
}

export interface FileTransferResult extends FileOffer {
  handleKey?: string;
  resourceKey?: string;
}

export type IceAddressFreshness =
  | "current"
  | "cached"
  | "unavailable";

export interface IceAddressSnapshot {
  addresses: string[];
  freshness: IceAddressFreshness;
  hasHostCandidate: boolean;
  hasMaskedLanCandidate: boolean;
}

export interface PeerClientCallbacks {
  onStatus: (status: ConnectionStatus, detail?: RuntimeCode) => void;
  onRoom: (room: RoomInfo) => void;
  onPublicAddresses: (snapshot: IceAddressSnapshot) => void;
  onAddressProbeState: (probing: boolean) => void;
  onConnectionRoute: (route?: ConnectionRoute) => void;
  onJoinRequest: (device: DeviceIdentity) => void;
  onPeer: (
    device: DeviceIdentity,
    rendezvous?: RendezvousInfo,
    automatic?: boolean,
  ) => void;
  onText: (message: {
    id: string;
    text: string;
    createdAt: number;
    replyTo?: ReplyReference;
  }) => void;
  onAck: (id: string) => void;
  onMessagePin: (messageId: string, pinnedAt: number | null) => void;
  onMessageDelete: (messageId: string) => boolean;
  onMessageDeleteResult: (
    messageId: string,
    deleted: boolean,
  ) => void;
  onConversationDelete: () => Promise<boolean>;
  onFileOffer: (offer: FileOffer) => void;
  onFileProgress: (
    messageId: string,
    direction: "send" | "receive",
    transferred: number,
    total: number,
  ) => void;
  onFileSent: (messageId: string, delivered: boolean) => void;
  onFileReceived: (result: FileTransferResult) => void;
  onFileRejected: (messageId: string, reason?: RuntimeCode) => void;
  onFileCancelled: (messageId: string) => void;
  onError: (code: RuntimeCode) => void;
}
