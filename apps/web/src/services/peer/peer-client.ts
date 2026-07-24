import {
  createRoomResponseSchema,
  dataMessageSchema,
  reconnectRoomResponseSchema,
  serverWsMessageSchema,
  stablePublicKey,
  type CreateRoomRequest,
  type DataMessage,
  type DeviceIdentity,
  type ReplyReference,
  type RtcSignal,
  type WsSessionInit,
} from "@peerto/protocol";
import { putFileHandle } from "../../lib/database";
import {
  customIpIceCandidate,
  customIpSessionDescription,
} from "../../lib/custom-ip";
import {
  signChallenge,
  type LocalIdentity,
} from "../../lib/identity";
import {
  addressesFromIceCandidateLine,
  connectionRouteFromCandidates,
  isMdnsCandidateAddress,
  reconcileConnectionRoutes,
  selectedCandidatePairFromStats,
  type ConnectionRoute,
  usableConnectionAddress,
} from "../../lib/network";
import {
  loadCachedIceAddresses,
  saveCachedIceAddresses,
} from "../../lib/ice-address-cache";
import {
  createWritableFileReceiveTarget,
  decodeFileChunkFrame,
  downloadBlob,
  encodeFileChunkFrame,
  FILE_CHUNK_FRAME_HEADER_BYTES,
  type FileReceiveMode,
  fileChunkSize,
  removeTemporaryFileReceiveTarget,
  retainTemporaryFileReceiveTarget,
  type WritableFileReceiveTarget,
} from "../file-transfer";
import { directConnectionFailureCode } from "../direct-connection-failure";
import { canRestoreExistingPeerConnection } from "../network-recovery";
import {
  relayUpgradeDelay,
  shouldScheduleRelayUpgrade,
} from "../relay-upgrade";
import { rtcConfiguration } from "../rtc-config";
import { PeerClientError } from "./peer-client-error";
import type {
  ApiConfig,
  FileOffer,
  FileTransferResult,
  IceAddressFreshness,
  IceAddressSnapshot,
  PeerClientCallbacks,
  PeerReconnectTarget,
  RuntimeCode,
} from "./types";

interface OutboundTransfer {
  offer: FileOffer;
  file: File;
  phase: "offered" | "sending" | "awaiting_complete";
  acknowledgedBytes: number;
  sentSequences: number;
  ackWaiter?: {
    targetBytes: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  };
  completionTimer?: number;
}

interface InboundTransfer {
  offer: FileOffer;
  receiveTarget?: WritableFileReceiveTarget;
  chunks?: ArrayBuffer[];
  received: number;
  ended: boolean;
  nextSequence: number;
  writtenSequences: number;
  lastAcknowledgedBytes: number;
  writeChain: Promise<void>;
}

function websocketUrl(
  role: "host" | "guest",
  code: string,
): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
  url.searchParams.set("code", code);
  return url.toString();
}

const CONNECTION_ATTEMPT_TIMEOUT_MS = 15_000;
const DISCONNECTED_RESTART_DELAY_MS = 4_000;
const MAX_ICE_RESTART_ATTEMPTS = 2;
const FILE_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const FILE_BUFFER_LOW_WATER_BYTES = 256 * 1024;
const FILE_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const FILE_RECEIVER_WINDOW_BYTES = 512 * 1024;
const FILE_RECEIVER_ACK_INTERVAL_BYTES = 128 * 1024;
const FILE_RECEIVER_ACK_TIMEOUT_MS = 60_000;
const MESSAGE_DELETE_TIMEOUT_MS = 8_000;
const CONVERSATION_DELETE_TIMEOUT_MS = 60_000;
const RELAY_UPGRADE_SETTLE_MS = 12_000;
const RELAY_UPGRADE_TRANSFER_DEFERRAL_MS = 30_000;
function addUsableAddress(
  addresses: Set<string>,
  address: string | null | undefined,
): void {
  const usableAddress = usableConnectionAddress(address || undefined);
  if (usableAddress) addresses.add(usableAddress);
}

export class PeerClient {
  private ws: WebSocket | undefined;
  private pc: RTCPeerConnection | undefined;
  private controlChannel: RTCDataChannel | undefined;
  private fileChannel: RTCDataChannel | undefined;
  private role: "host" | "guest" | undefined;
  private code: string | undefined;
  private shareToken: string | undefined;
  private connectionToken: string | undefined;
  private customPeerIp: string | undefined;
  private automaticReconnect = false;
  private peer: DeviceIdentity | undefined;
  private connectedNotified = false;
  private conversationDeleted = false;
  private signalingConsumed = false;
  private signalingTransport: "ws" | "data" = "ws";
  private signalingCloseExpected = false;
  private serverTerminalMessageReceived = false;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private heartbeat: number | undefined;
  private connectionTimer: number | undefined;
  private disconnectedTimer: number | undefined;
  private selectedPairTransport: RTCIceTransport | undefined;
  private selectedPairListener: (() => void) | undefined;
  private selectedPairRetryTimer: number | undefined;
  private selectedPairRetryAttempts = 0;
  private localConnectionRoute: ConnectionRoute | undefined;
  private remoteConnectionRoute:
    | Pick<ConnectionRoute, "kind" | "protocol">
    | undefined;
  private iceRestartAttempts = 0;
  private iceRestartPending = false;
  private lastPongAt = 0;
  private publicAddresses = new Set<string>();
  private publicAddressFreshness: IceAddressFreshness = "unavailable";
  private hasHostCandidate = false;
  private hasMaskedLanCandidate = false;
  private selectedPublicAddress: string | undefined;
  private addressProbeGeneration = 0;
  private addressProbeTimer: number | undefined;
  private iceServers: RTCIceServer[];
  private relayOnly: boolean;
  private relayUpgradeTimer: number | undefined;
  private relayUpgradeAttempts = 0;
  private relayUpgradePending = false;
  private operationGeneration = 0;
  private pendingOffers = new Map<string, FileOffer>();
  private pendingMessageDeletes = new Map<
    string,
    {
      messageId: string;
      timer: number;
    }
  >();
  private pendingConversationDeletes = new Map<
    string,
    {
      resolve: (deleted: boolean) => void;
      timer: number;
    }
  >();
  private outbound: OutboundTransfer | undefined;
  private inbound: InboundTransfer | undefined;

  constructor(
    private readonly identity: LocalIdentity,
    private readonly config: ApiConfig,
    private readonly callbacks: PeerClientCallbacks,
  ) {
    this.iceServers = config.iceServers;
    this.relayOnly = Boolean(config.relayOnly);
    const cachedAddresses = loadCachedIceAddresses();
    this.publicAddresses = new Set(cachedAddresses);
    this.publicAddressFreshness =
      cachedAddresses.length > 0 ? "cached" : "unavailable";
    this.emitPublicAddresses();
  }

  get activePeer(): DeviceIdentity | undefined {
    return this.peer;
  }

  get isOnline(): boolean {
    return this.controlChannel?.readyState === "open";
  }

  get activeHostRoomCode(): string | undefined {
    if (
      this.role === "host" &&
      this.code &&
      !this.signalingConsumed &&
      (this.ws?.readyState === WebSocket.CONNECTING ||
        this.ws?.readyState === WebSocket.OPEN)
    ) {
      return this.code;
    }
    return undefined;
  }

  setIceServers(
    iceServers: RTCIceServer[],
    relayOnly = this.relayOnly,
  ): void {
    const policyChanged = relayOnly !== this.relayOnly;
    this.iceServers = iceServers;
    this.relayOnly = relayOnly;
    const pc = this.pc;
    if (!pc || this.customPeerIp) return;
    try {
      pc.setConfiguration(
        rtcConfiguration(this.iceServers, this.relayOnly),
      );
    } catch {
      return;
    }
    if (!policyChanged || !this.isOnline) return;

    this.cancelRelayUpgrade();
    this.signalingTransport = "data";
    if (this.role === "host") {
      void this.startInBandIceRestart();
    } else {
      this.sendRtcSignal({ kind: "restart_request" });
    }
  }

  setDeviceName(name: string): void {
    this.identity.device = {
      ...this.identity.device,
      name: name.trim().slice(0, 64),
    };
  }

  async reconnectPeer(
    deviceId: string,
    customIp?: string,
  ): Promise<boolean> {
    this.customPeerIp = customIp;
    if (
      this.peer?.deviceId !== deviceId ||
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      this.callbacks.onStatus("offline", "peerOffline");
      return false;
    }

    this.callbacks.onStatus("reconnecting", "connectionInterrupted");
    this.sendWs({
      type: "signal",
      signal: { kind: "reconnect_request" },
    });

    try {
      await this.rebuildPeerConnection();
      return true;
    } catch {
      const pc = this.pc;
      if (pc) this.failDirectConnection(pc);
      return false;
    }
  }

  async refreshPeer(
    target: PeerReconnectTarget,
  ): Promise<"ice_restart" | "waiting" | "joining" | "cancelled"> {
    this.customPeerIp = target.customIp;
    if (
      this.peer?.deviceId === target.deviceId &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      const restarted = await this.reconnectPeer(
        target.deviceId,
        target.customIp,
      );
      if (restarted) return "ice_restart";
    }

    this.disconnect(false);
    this.customPeerIp = target.customIp;
    const operationGeneration = this.operationGeneration;
    this.callbacks.onStatus("reconnecting", "validatingCode");
    const response = await fetch("/api/rooms/reconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: target.code,
        device: this.identity.device,
        peerDeviceId: target.deviceId,
        connectionToken: target.token,
      }),
    });
    if (operationGeneration !== this.operationGeneration) {
      return "cancelled";
    }
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = payload as { error?: string };
      throw new PeerClientError(
        error.error || "RECONNECT_ROOM_FAILED",
      );
    }
    const room = reconnectRoomResponseSchema.parse(payload);

    this.role = room.role;
    this.code = room.code;
    this.connectionToken = target.token;
    this.automaticReconnect = true;
    this.signalingConsumed = false;
    if (room.role === "host") {
      this.openWebSocket(
        "host",
        room.code,
        target.token,
        target.token,
        this.identity.device.deviceId,
        target.deviceId,
      );
      return "waiting";
    }

    this.openWebSocket(
      "guest",
      room.code,
      undefined,
      target.token,
      this.identity.device.deviceId,
      target.deviceId,
    );
    return "joining";
  }

  async startHost(turnstileToken?: string): Promise<void> {
    this.disconnect(false);
    this.customPeerIp = undefined;
    this.role = "host";
    this.callbacks.onStatus("signaling", "generatingCode");

    const body: CreateRoomRequest = {
      host: this.identity.device,
      ...(turnstileToken ? { turnstileToken } : {}),
    };
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = payload as { error?: string };
      throw new PeerClientError(error.error || "CREATE_ROOM_FAILED");
    }
    const room = createRoomResponseSchema.parse(payload);
    this.code = room.code;
    this.connectionToken = room.connectionToken;
    this.callbacks.onRoom({
      code: room.code,
      expiresAt: room.expiresAt,
      shareToken: room.shareToken,
    });
    this.openWebSocket(
      "host",
      room.code,
      room.hostToken,
      room.connectionToken,
    );
  }

  join(code: string, shareToken?: string): void {
    this.disconnect(false);
    this.customPeerIp = undefined;
    this.role = "guest";
    this.code = code;
    this.shareToken = shareToken;
    this.connectionToken = undefined;
    this.customPeerIp = undefined;
    this.callbacks.onStatus("signaling", "validatingCode");
    this.openWebSocket("guest", code);
  }

  acceptPeer(deviceId: string): void {
    this.sendWs({ type: "accept_peer", deviceId });
    this.callbacks.onStatus("connecting", "establishingP2P");
  }

  rejectPeer(deviceId: string): void {
    this.sendWs({ type: "reject_peer", deviceId });
  }

  sendText(
    id: string,
    text: string,
    createdAt: number,
    replyTo?: ReplyReference,
  ): boolean {
    return this.sendData({
      type: "chat",
      id,
      text,
      createdAt,
      ...(replyTo ? { replyTo } : {}),
    });
  }

  sendMessagePin(messageId: string, pinnedAt: number | null): boolean {
    return this.sendData({ type: "message_pin", messageId, pinnedAt });
  }

  deleteMessage(messageId: string): boolean {
    const requestId = crypto.randomUUID();
    if (
      !this.sendData({
        type: "message_delete",
        requestId,
        messageId,
      })
    ) {
      return false;
    }
    const timer = window.setTimeout(() => {
      const pending = this.pendingMessageDeletes.get(requestId);
      if (!pending) return;
      this.pendingMessageDeletes.delete(requestId);
      this.callbacks.onMessageDeleteResult(
        pending.messageId,
        false,
      );
    }, MESSAGE_DELETE_TIMEOUT_MS);
    this.pendingMessageDeletes.set(requestId, { messageId, timer });
    return true;
  }

  deleteConversation(): Promise<boolean> {
    if (!this.isOnline) return Promise.resolve(false);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        const pending = this.pendingConversationDeletes.get(requestId);
        if (!pending) return;
        this.pendingConversationDeletes.delete(requestId);
        pending.resolve(false);
      }, CONVERSATION_DELETE_TIMEOUT_MS);
      this.pendingConversationDeletes.set(requestId, {
        resolve,
        timer,
      });
      if (
        !this.sendData({
          type: "conversation_delete",
          requestId,
        })
      ) {
        window.clearTimeout(timer);
        this.pendingConversationDeletes.delete(requestId);
        resolve(false);
      }
    });
  }

  async prepareConversationDeletion(): Promise<void> {
    await this.discardAllFileTransfers();
  }

  offerFile(file: File, replyTo?: ReplyReference): FileOffer {
    if (!this.isOnline || this.fileChannel?.readyState !== "open") {
      throw new PeerClientError("FILE_CHANNEL_NOT_READY");
    }
    if (file.size > this.config.maxFileBytes) {
      throw new PeerClientError("FILE_TOO_LARGE", {
        maxFileBytes: this.config.maxFileBytes,
      });
    }
    if (this.outbound) throw new PeerClientError("FILE_SEND_BUSY");

    const offer: FileOffer = {
      transferId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      createdAt: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };
    this.outbound = {
      offer,
      file,
      phase: "offered",
      acknowledgedBytes: 0,
      sentSequences: 0,
    };
    if (!this.sendData({ type: "file_offer", ...offer })) {
      this.outbound = undefined;
      throw new PeerClientError("FILE_CHANNEL_NOT_READY");
    }
    return offer;
  }

  async acceptFile(
    transferId: string,
    handle?: FileSystemFileHandle,
  ): Promise<FileReceiveMode> {
    const offer = this.pendingOffers.get(transferId);
    if (!offer) throw new PeerClientError("FILE_OFFER_EXPIRED");
    if (this.inbound) throw new PeerClientError("FILE_RECEIVE_BUSY");

    const receiveTarget = await createWritableFileReceiveTarget(
      offer.messageId,
      handle,
    );
    if (this.pendingOffers.get(transferId) !== offer) {
      try {
        await receiveTarget?.writable.abort("FILE_OFFER_EXPIRED");
      } catch {
        // Cancellation may race with writable creation.
      }
      await removeTemporaryFileReceiveTarget(
        receiveTarget?.temporary,
      );
      throw new PeerClientError("FILE_OFFER_EXPIRED");
    }
    this.inbound = {
      offer,
      ...(receiveTarget
        ? { receiveTarget }
        : { chunks: [] }),
      received: 0,
      ended: false,
      nextSequence: 0,
      writtenSequences: 0,
      lastAcknowledgedBytes: 0,
      writeChain: Promise.resolve(),
    };
    this.pendingOffers.delete(transferId);
    if (!this.sendData({ type: "file_accept", transferId })) {
      this.inbound = undefined;
      await receiveTarget?.writable.abort("CONTROL_CHANNEL_CLOSED");
      await removeTemporaryFileReceiveTarget(receiveTarget?.temporary);
      throw new PeerClientError("FILE_CHANNEL_NOT_READY");
    }
    await this.maybeCompleteInbound();
    return receiveTarget?.mode || "memory";
  }

  rejectFile(transferId: string, reason?: string): void {
    this.pendingOffers.delete(transferId);
    this.sendData({
      type: "file_reject",
      transferId,
      ...(reason ? { reason } : {}),
    });
  }

  cancelFile(messageId: string): boolean {
    if (!this.sendData({ type: "file_cancel", messageId })) {
      return false;
    }
    this.discardFileTransfer(messageId);
    this.callbacks.onFileCancelled(messageId);
    return true;
  }

  disconnect(notify = true): void {
    this.operationGeneration += 1;
    this.stopHeartbeat();
    this.clearConnectionTimers();
    this.stopSelectedPairMonitor();
    this.cancelRelayUpgrade();
    this.cancelAddressProbe();
    this.clearPendingMessageDeletes(notify);
    this.clearPendingConversationDeletes();
    if (this.inbound) {
      const inbound = this.inbound;
      void inbound.receiveTarget?.writable
        .abort("CONNECTION_CLOSED")
        .finally(() =>
          removeTemporaryFileReceiveTarget(
            inbound.receiveTarget?.temporary,
          ),
        );
    }
    this.inbound = undefined;
    this.clearOutbound();
    this.pendingOffers.clear();
    const controlChannel = this.controlChannel;
    const fileChannel = this.fileChannel;
    const pc = this.pc;
    const ws = this.ws;
    this.controlChannel = undefined;
    this.fileChannel = undefined;
    this.pc = undefined;
    this.ws = undefined;
    controlChannel?.close();
    fileChannel?.close();
    pc?.close();
    ws?.close(1000);
    this.peer = undefined;
    this.shareToken = undefined;
    this.connectionToken = undefined;
    this.customPeerIp = undefined;
    this.automaticReconnect = false;
    this.connectedNotified = false;
    this.conversationDeleted = false;
    this.signalingConsumed = false;
    this.signalingTransport = "ws";
    this.signalingCloseExpected = false;
    this.serverTerminalMessageReceived = false;
    this.iceRestartAttempts = 0;
    this.iceRestartPending = false;
    this.queuedCandidates = [];
    this.markAddressesCached();
    this.clearConnectionRoute();
    if (notify) this.callbacks.onStatus("offline", "ready");
  }

  setNetworkAvailable(
    online: boolean,
    probeAddresses = true,
  ): void {
    if (!online) {
      this.operationGeneration += 1;
      this.stopHeartbeat();
      this.stopSelectedPairMonitor();
      this.cancelRelayUpgrade();
      this.cancelAddressProbe();
      this.selectedPublicAddress = undefined;
      this.hasHostCandidate = false;
      this.hasMaskedLanCandidate = false;
      this.markAddressesCached();
      this.clearConnectionRoute();
      this.clearPendingConversationDeletes();
      this.callbacks.onStatus("network_offline", "networkOffline");
      return;
    }
    const currentPeerConnection = this.pc;
    if (
      canRestoreExistingPeerConnection(
        this.controlChannel?.readyState,
        currentPeerConnection?.connectionState,
      )
    ) {
      this.startSelectedPairMonitor(currentPeerConnection!);
      this.markOnline();
    } else {
      this.callbacks.onStatus("offline", "networkRestored");
    }
    if (probeAddresses) void this.probePublicAddresses();
  }

  async probePublicAddresses(): Promise<void> {
    const generation = ++this.addressProbeGeneration;
    this.beginAddressProbe(generation);
    this.selectedPublicAddress = undefined;
    this.hasHostCandidate = false;
    this.hasMaskedLanCandidate = false;
    this.markAddressesCached();
    let probe: RTCPeerConnection | undefined;
    const discovered = new Set<string>();
    let hasHostCandidate = false;
    let hasMaskedLanCandidate = false;

    const collectCandidate = (
      candidateType: RTCIceCandidateType | null | undefined,
      address: string | null | undefined,
      relatedAddress?: string | null,
    ) => {
      if (candidateType === "host") {
        hasHostCandidate = true;
        if (isMdnsCandidateAddress(address)) {
          hasMaskedLanCandidate = true;
        }
      }
      if (
        candidateType !== "host" &&
        candidateType !== "srflx" &&
        candidateType !== "prflx"
      ) {
        return;
      }
      addUsableAddress(discovered, address);
      addUsableAddress(discovered, relatedAddress);
      this.publishAddressDiscovery(
        generation,
        discovered,
        hasHostCandidate,
        hasMaskedLanCandidate,
      );
    };

    try {
      probe = new RTCPeerConnection(rtcConfiguration(this.iceServers));
      probe.createDataChannel("ip-probe");

      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 8_000);
        probe?.addEventListener("icecandidate", (event) => {
          if (!event.candidate) {
            window.clearTimeout(timer);
            resolve();
            return;
          }
          const parsed = addressesFromIceCandidateLine(
            event.candidate.candidate,
          );
          collectCandidate(
            event.candidate.type,
            event.candidate.address || parsed.address,
            event.candidate.relatedAddress || parsed.relatedAddress,
          );
        });
        void probe
          ?.createOffer()
          .then((offer) => probe?.setLocalDescription(offer))
          .catch(() => {
            window.clearTimeout(timer);
            resolve();
          });
      });

      try {
        const stats = await probe.getStats();
        stats.forEach((report) => {
          if (
            report.type === "local-candidate" &&
            (report.candidateType === "host" ||
              report.candidateType === "srflx" ||
              report.candidateType === "prflx")
          ) {
            collectCandidate(
              report.candidateType as RTCIceCandidateType,
              typeof report.address === "string"
                ? report.address
                : undefined,
              typeof report.relatedAddress === "string"
                ? report.relatedAddress
                : undefined,
            );
          }
        });
      } catch {
        // Candidate events above remain the authoritative result.
      }

      if (generation !== this.addressProbeGeneration) return;
      this.publishAddressDiscovery(
        generation,
        discovered,
        hasHostCandidate,
        hasMaskedLanCandidate,
      );
    } finally {
      probe?.close();
      this.finishAddressProbe(generation);
    }
  }

  private openWebSocket(
    role: "host" | "guest",
    code: string,
    token?: string,
    connectionToken?: string,
    deviceId?: string,
    peerDeviceId?: string,
  ): void {
    const ws = new WebSocket(websocketUrl(role, code));
    this.ws = ws;
    this.signalingTransport = "ws";
    this.signalingCloseExpected = false;
    this.serverTerminalMessageReceived = false;

    ws.addEventListener("open", () => {
      const init: WsSessionInit = {
        type: "session_init",
        ...(token ? { token } : {}),
        ...(connectionToken ? { connectionToken } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(peerDeviceId ? { peerDeviceId } : {}),
      };
      ws.send(JSON.stringify(init));
    });
    ws.addEventListener("message", (event) => {
      void this.handleServerMessage(event.data);
    });
    ws.addEventListener("error", () => {
      this.callbacks.onError("signalingUnavailable");
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.signalingCloseExpected) return;
      if (this.peer && !this.serverTerminalMessageReceived) {
        this.disconnect(false);
        this.callbacks.onStatus("offline", "peerOffline");
        return;
      }
      if (!this.isOnline && !this.signalingConsumed) {
        this.callbacks.onStatus("failed", "signalingDisconnected");
      }
    });
  }

  private async handleServerMessage(raw: unknown): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      this.callbacks.onError("invalidServerMessage");
      return;
    }
    const parsed = serverWsMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.callbacks.onError("incompatibleServerMessage");
      return;
    }

    const message = parsed.data;
    if (message.type === "challenge") {
      if (!this.code) return;
      this.callbacks.onStatus("authenticating", "validatingIdentity");
      const signature = await signChallenge(
        this.identity.keyPair.privateKey,
        this.code,
        message.challenge,
      );
      this.sendWs({
        type: "authenticate",
        device: this.identity.device,
        signature,
        ...(this.shareToken ? { shareToken: this.shareToken } : {}),
        ...(this.connectionToken
          ? { connectionToken: this.connectionToken }
          : {}),
      });
    } else if (message.type === "room_ready") {
      this.callbacks.onStatus(
        "waiting",
        this.automaticReconnect ? "waitingForKnownPeer" : "codeReady",
      );
    } else if (message.type === "join_request") {
      this.callbacks.onJoinRequest(message.device);
    } else if (message.type === "peer_accepted") {
      const automatic = this.automaticReconnect;
      this.peer = message.peer;
      this.connectionToken = message.rendezvous.token;
      this.automaticReconnect = false;
      this.callbacks.onPeer(
        message.peer,
        message.rendezvous,
        automatic,
      );
      this.callbacks.onStatus("connecting", "negotiatingP2P");
      await this.preparePeerConnection();
    } else if (message.type === "peer_rejected") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      this.callbacks.onStatus("failed", "peerRejected");
    } else if (message.type === "signal") {
      await this.handleSignal(message.signal, "ws");
    } else if (message.type === "room_consumed") {
      this.signalingConsumed = true;
      this.signalingCloseExpected = true;
    } else if (message.type === "room_closed") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      const reasons: Record<typeof message.reason, RuntimeCode> = {
        expired: "codeExpired",
        host_offline: "hostOffline",
        ip_changed: "hostIpChanged",
        invalid_code: "invalidCode",
        replaced: "connectionReplaced",
      };
      this.callbacks.onStatus("failed", reasons[message.reason]);
    } else if (message.type === "error") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      const code = `server.${message.code}` as RuntimeCode;
      this.callbacks.onStatus("failed", code);
      this.callbacks.onError(code);
    }
  }

  private async preparePeerConnection(): Promise<void> {
    if (this.pc) return;
    const addressProbeGeneration = ++this.addressProbeGeneration;
    this.beginAddressProbe(addressProbeGeneration);
    this.selectedPublicAddress = undefined;
    this.hasHostCandidate = false;
    this.hasMaskedLanCandidate = false;
    this.iceRestartAttempts = 0;
    this.iceRestartPending = false;
    this.cancelRelayUpgrade();
    this.markAddressesCached();
    this.clearConnectionRoute();
    const discovered = new Set<string>();
    let hasHostCandidate = false;
    let hasMaskedLanCandidate = false;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(
        rtcConfiguration(
          this.customPeerIp ? [] : this.iceServers,
          this.customPeerIp ? false : this.relayOnly,
        ),
      );
    } catch (error) {
      this.finishAddressProbe(addressProbeGeneration);
      throw error;
    }
    this.pc = pc;

    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        this.publishAddressDiscovery(
          addressProbeGeneration,
          discovered,
          hasHostCandidate,
          hasMaskedLanCandidate,
        );
        this.finishAddressProbe(addressProbeGeneration);
        return;
      }
      const parsed = addressesFromIceCandidateLine(
        event.candidate.candidate,
      );
      const candidateAddress =
        event.candidate.address || parsed.address;
      const relatedAddress =
        event.candidate.relatedAddress || parsed.relatedAddress;
      if (event.candidate.type === "host") {
        hasHostCandidate = true;
        if (isMdnsCandidateAddress(candidateAddress)) {
          hasMaskedLanCandidate = true;
        }
      }
      if (
        event.candidate.type === "host" ||
        event.candidate.type === "srflx" ||
        event.candidate.type === "prflx"
      ) {
        addUsableAddress(discovered, candidateAddress);
        addUsableAddress(discovered, relatedAddress);
        this.publishAddressDiscovery(
          addressProbeGeneration,
          discovered,
          hasHostCandidate,
          hasMaskedLanCandidate,
        );
      }
      this.sendRtcSignal({
        kind: "candidate",
        candidate: {
          candidate: event.candidate.candidate,
          ...(event.candidate.sdpMid !== null
            ? { sdpMid: event.candidate.sdpMid }
            : {}),
          ...(event.candidate.sdpMLineIndex !== null
            ? { sdpMLineIndex: event.candidate.sdpMLineIndex }
            : {}),
          ...(event.candidate.usernameFragment !== null
            ? {
                usernameFragment:
                  event.candidate.usernameFragment,
              }
            : {}),
        },
      });
    });
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        this.finishAddressProbe(addressProbeGeneration);
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.finishAddressProbe(addressProbeGeneration);
        this.clearConnectionTimers();
        this.iceRestartAttempts = 0;
        this.iceRestartPending = false;
        this.startSelectedPairMonitor(pc);
        this.markOnline();
      } else if (pc.connectionState === "failed") {
        this.cancelRelayUpgrade();
        this.stopSelectedPairMonitor();
        this.clearConnectionRoute();
        this.callbacks.onStatus("reconnecting", "connectionInterrupted");
        void this.attemptIceRestart(pc);
      } else if (pc.connectionState === "closed") {
        this.cancelRelayUpgrade();
        this.clearConnectionTimers();
        this.stopSelectedPairMonitor();
        this.clearConnectionRoute();
        this.callbacks.onStatus("offline", "peerOffline");
      } else if (pc.connectionState === "disconnected") {
        this.cancelRelayUpgrade();
        this.clearConnectionRoute();
        this.callbacks.onStatus("reconnecting", "connectionInterrupted");
        if (this.disconnectedTimer) {
          window.clearTimeout(this.disconnectedTimer);
        }
        this.disconnectedTimer = window.setTimeout(() => {
          if (pc.connectionState === "disconnected") {
            void this.attemptIceRestart(pc);
          }
        }, DISCONNECTED_RESTART_DELAY_MS);
      }
    });
    this.armConnectionTimer(pc);

    if (this.role === "host") {
      this.attachControlChannel(
        pc.createDataChannel("control", { ordered: true }),
      );
      this.attachFileChannel(
        pc.createDataChannel("file", { ordered: true }),
      );
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendDescription(pc.localDescription!);
    } else {
      pc.addEventListener("datachannel", (event) => {
        if (event.channel.label === "control") {
          this.attachControlChannel(event.channel);
        } else if (event.channel.label === "file") {
          this.attachFileChannel(event.channel);
        }
      });
    }
  }

  private async handleSignal(
    signal: RtcSignal,
    transport: "ws" | "data",
  ): Promise<void> {
    this.signalingTransport = transport;
    if (signal.kind === "reconnect_request") {
      await this.rebuildPeerConnection();
      return;
    }

    if (!this.pc) await this.preparePeerConnection();
    const pc = this.pc;
    if (!pc) return;

    if (signal.kind === "restart_request") {
      if (this.role === "host") {
        if (transport === "data") {
          await this.startInBandIceRestart(true);
        } else {
          await this.attemptIceRestart(pc);
        }
      }
    } else if (signal.kind === "description") {
      const receivedDescription: RTCSessionDescriptionInit =
        signal.description.sdp === undefined
          ? { type: signal.description.type }
          : {
              type: signal.description.type,
              sdp: signal.description.sdp,
            };
      const description = this.customPeerIp
        ? customIpSessionDescription(
            receivedDescription,
            this.customPeerIp,
          )
        : receivedDescription;
      await pc.setRemoteDescription(description);
      for (const candidate of this.queuedCandidates.splice(0)) {
        await pc.addIceCandidate(candidate);
      }
      if (signal.description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendDescription(pc.localDescription!);
      }
    } else {
      const receivedCandidate: RTCIceCandidateInit = {
        candidate: signal.candidate.candidate,
        ...(signal.candidate.sdpMid !== undefined
          ? { sdpMid: signal.candidate.sdpMid }
          : {}),
        ...(signal.candidate.sdpMLineIndex !== undefined
          ? { sdpMLineIndex: signal.candidate.sdpMLineIndex }
          : {}),
        ...(signal.candidate.usernameFragment !== undefined
          ? { usernameFragment: signal.candidate.usernameFragment }
          : {}),
      };
      const candidate = this.customPeerIp
        ? customIpIceCandidate(receivedCandidate, this.customPeerIp)
        : receivedCandidate;
      if (!candidate) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        this.queuedCandidates.push(candidate);
      }
    }
  }

  private sendDescription(
    description: RTCSessionDescription,
  ): boolean {
    return this.sendRtcSignal({
      kind: "description",
      description: description.toJSON(),
    });
  }

  private attachControlChannel(channel: RTCDataChannel): void {
    this.controlChannel = channel;
    channel.addEventListener("open", () => {
      this.markOnline();
      this.sendData({
        type: "peer_hello",
        device: this.identity.device,
        fileChunkProtocol: 2,
      });
      this.sendConnectionRoute();
    });
    channel.addEventListener("message", (event) => {
      this.handleDataMessage(event.data);
    });
    channel.addEventListener("close", () => {
      if (this.controlChannel !== channel) return;
      this.stopHeartbeat();
      this.clearPendingConversationDeletes();
      this.callbacks.onStatus("offline", "peerOffline");
    });
  }

  private attachFileChannel(channel: RTCDataChannel): void {
    this.fileChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_BYTES;
    channel.addEventListener("message", (event) => {
      void this.handleFileChunk(event.data);
    });
    channel.addEventListener("error", () => {
      this.handleFileChannelFailure(channel);
    });
    channel.addEventListener("close", () => {
      this.handleFileChannelFailure(channel);
    });
  }

  private markOnline(): void {
    if (this.controlChannel?.readyState !== "open") return;
    this.callbacks.onStatus("online");
    this.lastPongAt = Date.now();
    if (!this.connectedNotified) {
      this.connectedNotified = true;
      this.sendWs({ type: "connected" });
    }
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.lastPongAt > 30_000) {
        this.callbacks.onStatus("offline", "heartbeatTimeout");
        this.pc?.close();
        this.stopHeartbeat();
        return;
      }
      this.sendData({ type: "ping", at: Date.now() });
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private handleDataMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = dataMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if (
      this.conversationDeleted &&
      message.type !== "conversation_delete" &&
      message.type !== "ping" &&
      message.type !== "pong"
    ) {
      return;
    }

    if (message.type === "rtc_signal") {
      void this.handleSignal(message.signal, "data").catch(() => {
        this.relayUpgradePending = false;
        this.scheduleRelayUpgrade();
      });
    } else if (message.type === "chat") {
      this.callbacks.onText({
        id: message.id,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
      this.sendData({ type: "ack", id: message.id });
    } else if (message.type === "ack") {
      this.callbacks.onAck(message.id);
    } else if (message.type === "message_pin") {
      this.callbacks.onMessagePin(message.messageId, message.pinnedAt);
    } else if (message.type === "message_delete") {
      let deleted = false;
      try {
        deleted = this.callbacks.onMessageDelete(message.messageId);
      } catch {
        deleted = false;
      }
      this.sendData({
        type: "message_delete_result",
        requestId: message.requestId,
        messageId: message.messageId,
        deleted,
      });
    } else if (message.type === "message_delete_result") {
      const pending = this.pendingMessageDeletes.get(
        message.requestId,
      );
      if (!pending || pending.messageId !== message.messageId) return;
      window.clearTimeout(pending.timer);
      this.pendingMessageDeletes.delete(message.requestId);
      this.callbacks.onMessageDeleteResult(
        message.messageId,
        message.deleted,
      );
    } else if (message.type === "conversation_delete") {
      void this.handleConversationDeleteRequest(message.requestId);
    } else if (message.type === "conversation_delete_result") {
      const pending = this.pendingConversationDeletes.get(
        message.requestId,
      );
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.pendingConversationDeletes.delete(message.requestId);
      pending.resolve(message.deleted);
    } else if (message.type === "peer_hello") {
      const acceptedPeer = this.peer;
      if (
        !acceptedPeer ||
        acceptedPeer.deviceId !== message.device.deviceId ||
        stablePublicKey(acceptedPeer.publicKey) !==
          stablePublicKey(message.device.publicKey)
      ) {
        this.disconnect(false);
        this.callbacks.onStatus("failed", "peerIdentityMismatch");
        this.callbacks.onError("peerIdentityMismatch");
        return;
      }
      this.peer = message.device;
      this.callbacks.onPeer(message.device, undefined, true);
    } else if (message.type === "connection_route") {
      this.remoteConnectionRoute = {
        kind: message.kind,
        ...(message.protocol ? { protocol: message.protocol } : {}),
      };
      this.publishConnectionRoute();
    } else if (message.type === "ping") {
      this.sendData({ type: "pong", at: message.at });
    } else if (message.type === "pong") {
      this.lastPongAt = Date.now();
    } else if (message.type === "file_offer") {
      const offer: FileOffer = {
        transferId: message.transferId,
        messageId: message.messageId,
        name: message.name,
        size: message.size,
        mime: message.mime,
        createdAt: message.createdAt,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      };
      if (
        message.size > this.config.maxFileBytes ||
        this.inbound ||
        this.pendingOffers.size > 0
      ) {
        this.sendData({
          type: "file_reject",
          transferId: message.transferId,
          reason:
            message.size > this.config.maxFileBytes
              ? "FILE_TOO_LARGE"
              : "FILE_RECEIVE_BUSY",
        });
        return;
      }
      this.pendingOffers.set(message.transferId, offer);
      this.callbacks.onFileOffer(offer);
    } else if (message.type === "file_accept") {
      const transfer = this.outbound;
      if (
        transfer?.offer.transferId === message.transferId &&
        transfer.phase === "offered"
      ) {
        transfer.phase = "sending";
        void this.sendFileContents(transfer);
      }
    } else if (message.type === "file_reject") {
      if (this.outbound?.offer.transferId === message.transferId) {
        const reason =
          message.reason === "FILE_TOO_LARGE"
            ? "server.FILE_TOO_LARGE"
            : message.reason === "FILE_RECEIVE_BUSY"
              ? "server.FILE_RECEIVE_BUSY"
              : message.reason === "FILE_WRITE_FAILED"
                ? "peerFileWriteFailed"
                : "fileRejected";
        this.failOutbound(this.outbound, reason);
      }
    } else if (message.type === "file_end") {
      const inbound = this.inbound;
      if (inbound?.offer.transferId === message.transferId) {
        inbound.ended = true;
        void inbound.writeChain
          .then(() => this.maybeCompleteInbound(inbound))
          .catch(() => this.failInbound(inbound));
      }
    } else if (message.type === "file_complete") {
      const transfer = this.outbound;
      if (
        transfer?.offer.transferId === message.transferId &&
        transfer.phase === "awaiting_complete"
      ) {
        this.finishOutbound(transfer, true);
      }
    } else if (message.type === "file_chunk_ack") {
      const transfer = this.outbound;
      if (
        transfer?.offer.transferId !== message.transferId ||
        message.received < transfer.acknowledgedBytes ||
        message.received > transfer.file.size ||
        message.nextSequence > transfer.sentSequences
      ) {
        return;
      }
      transfer.acknowledgedBytes = message.received;
      const waiter = transfer.ackWaiter;
      if (waiter && message.received >= waiter.targetBytes) {
        window.clearTimeout(waiter.timer);
        delete transfer.ackWaiter;
        waiter.resolve();
      }
    } else if (message.type === "file_cancel") {
      this.discardFileTransfer(message.messageId);
      this.callbacks.onFileCancelled(message.messageId);
    }
  }

  private async sendFileContents(transfer: OutboundTransfer): Promise<void> {
    const channel = this.fileChannel;
    if (!channel || channel.readyState !== "open") {
      this.failOutbound(transfer, "fileChannelClosed");
      return;
    }

    const negotiatedMaxMessageSize = this.pc?.sctp?.maxMessageSize;
    const chunkSize = fileChunkSize(
      typeof negotiatedMaxMessageSize === "number"
        ? Math.max(
            1,
            negotiatedMaxMessageSize - FILE_CHUNK_FRAME_HEADER_BYTES,
          )
        : negotiatedMaxMessageSize,
    );
    let offset = 0;
    let sequence = 0;
    try {
      while (offset < transfer.file.size) {
        if (this.outbound !== transfer) return;
        await this.waitForReceiverCredit(transfer, offset);
        await this.waitForFileBuffer(channel);
        if (this.outbound !== transfer) return;
        const chunk = await transfer.file
          .slice(offset, offset + chunkSize)
          .arrayBuffer();
        channel.send(
          encodeFileChunkFrame(
            transfer.offer.transferId,
            sequence,
            chunk,
          ),
        );
        offset += chunk.byteLength;
        sequence += 1;
        transfer.sentSequences = sequence;
        this.callbacks.onFileProgress(
          transfer.offer.messageId,
          "send",
          offset,
          transfer.file.size,
        );
      }
      await this.waitForReceiverAcknowledgement(
        transfer,
        transfer.file.size,
      );
      await this.waitForFileBuffer(channel, FILE_BUFFER_LOW_WATER_BYTES);
      if (this.outbound !== transfer) return;
      if (!this.sendData({
        type: "file_end",
        transferId: transfer.offer.transferId,
      })) {
        throw new PeerClientError("FILE_CHANNEL_NOT_READY");
      }
      transfer.phase = "awaiting_complete";
      transfer.completionTimer = window.setTimeout(() => {
        this.failOutbound(transfer, "fileSendFailed");
      }, FILE_COMPLETION_TIMEOUT_MS);
    } catch {
      this.failOutbound(transfer, "fileSendFailed");
    }
  }

  private async handleFileChunk(raw: unknown): Promise<void> {
    const inbound = this.inbound;
    if (!inbound) return;
    const receivedFrame =
      raw instanceof ArrayBuffer
        ? raw
        : raw instanceof Blob
          ? await raw.arrayBuffer()
          : undefined;
    if (!receivedFrame) return;

    const frame = decodeFileChunkFrame(receivedFrame);
    if (!frame) {
      await this.failInbound(inbound);
      return;
    }
    if (frame.transferId !== inbound.offer.transferId) {
      return;
    }
    if (frame.sequence < inbound.nextSequence) {
      this.sendFileChunkAcknowledgement(inbound);
      return;
    }
    if (frame.sequence !== inbound.nextSequence) {
      await this.failInbound(inbound);
      return;
    }
    inbound.nextSequence += 1;
    const chunk = frame.payload;

    const nextWrite = inbound.writeChain.then(async () => {
      if (this.inbound !== inbound) return;
      if (inbound.received + chunk.byteLength > inbound.offer.size) {
        throw new PeerClientError("FILE_SIZE_MISMATCH");
      }
      if (inbound.receiveTarget) {
        await inbound.receiveTarget.writable.write(chunk);
      } else {
        inbound.chunks?.push(chunk);
      }
      inbound.received += chunk.byteLength;
      inbound.writtenSequences += 1;
      if (
        inbound.received - inbound.lastAcknowledgedBytes >=
          FILE_RECEIVER_ACK_INTERVAL_BYTES ||
        inbound.received === inbound.offer.size
      ) {
        this.sendFileChunkAcknowledgement(inbound);
      }
      this.callbacks.onFileProgress(
        inbound.offer.messageId,
        "receive",
        inbound.received,
        inbound.offer.size,
      );
      await this.maybeCompleteInbound(inbound);
    });
    inbound.writeChain = nextWrite;
    await nextWrite.catch(() => this.failInbound(inbound));
  }

  private async maybeCompleteInbound(
    expectedInbound = this.inbound,
  ): Promise<void> {
    const inbound = expectedInbound;
    if (
      !inbound ||
      this.inbound !== inbound ||
      !inbound.ended ||
      inbound.received !== inbound.offer.size
    ) {
      return;
    }

    if (
      inbound.receiveTarget?.mode === "handle" &&
      inbound.receiveTarget.handle
    ) {
      await inbound.receiveTarget.writable.close();
      const handleKey = `file:${inbound.offer.messageId}`;
      await putFileHandle(handleKey, inbound.receiveTarget.handle);
      if (this.inbound !== inbound) return;
      this.inbound = undefined;
      this.callbacks.onFileReceived({
        ...inbound.offer,
        handleKey,
      });
      this.sendData({
        type: "file_complete",
        transferId: inbound.offer.transferId,
      });
      return;
    }

    if (
      inbound.receiveTarget?.mode === "opfs" &&
      inbound.receiveTarget.temporary
    ) {
      await inbound.receiveTarget.writable.close();
      const temporary = inbound.receiveTarget.temporary;
      if (this.inbound !== inbound) return;
      this.inbound = undefined;
      const resourceKey =
        retainTemporaryFileReceiveTarget(temporary);
      this.callbacks.onFileReceived({
        ...inbound.offer,
        resourceKey,
      });
      this.sendData({
        type: "file_complete",
        transferId: inbound.offer.transferId,
      });
      return;
    }

    const blob = new Blob(inbound.chunks || [], {
      type: inbound.offer.mime,
    });
    downloadBlob(blob, inbound.offer.name);
    if (this.inbound !== inbound) return;
    this.inbound = undefined;
    this.callbacks.onFileReceived(inbound.offer);
    this.sendData({
      type: "file_complete",
      transferId: inbound.offer.transferId,
    });
  }

  private waitForFileBuffer(
    channel: RTCDataChannel,
    limit = FILE_BUFFER_HIGH_WATER_BYTES,
  ): Promise<void> {
    if (this.fileChannel !== channel || channel.readyState !== "open") {
      return Promise.reject(new PeerClientError("FILE_CHANNEL_NOT_READY"));
    }
    if (channel.bufferedAmount <= limit) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onFailure);
        channel.removeEventListener("error", onFailure);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onFailure = () => {
        cleanup();
        reject(new PeerClientError("FILE_CHANNEL_NOT_READY"));
      };

      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onFailure);
      channel.addEventListener("error", onFailure);
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        onLow();
      }
    });
  }

  private waitForReceiverCredit(
    transfer: OutboundTransfer,
    sentBytes: number,
  ): Promise<void> {
    if (
      sentBytes - transfer.acknowledgedBytes <
      FILE_RECEIVER_WINDOW_BYTES
    ) {
      return Promise.resolve();
    }
    return this.waitForReceiverAcknowledgement(
      transfer,
      sentBytes - FILE_RECEIVER_WINDOW_BYTES +
        FILE_RECEIVER_ACK_INTERVAL_BYTES,
    );
  }

  private waitForReceiverAcknowledgement(
    transfer: OutboundTransfer,
    targetBytes: number,
  ): Promise<void> {
    if (transfer.acknowledgedBytes >= targetBytes) {
      return Promise.resolve();
    }
    if (transfer.ackWaiter) {
      return Promise.reject(
        new PeerClientError("FILE_ACK_WAITER_CONFLICT"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (transfer.ackWaiter?.timer !== timer) return;
        delete transfer.ackWaiter;
        reject(new PeerClientError("FILE_ACK_TIMEOUT"));
      }, FILE_RECEIVER_ACK_TIMEOUT_MS);
      transfer.ackWaiter = {
        targetBytes,
        resolve,
        reject,
        timer,
      };
    });
  }

  private sendFileChunkAcknowledgement(
    inbound: InboundTransfer,
  ): void {
    if (this.inbound !== inbound) return;
    if (
      this.sendData({
        type: "file_chunk_ack",
        transferId: inbound.offer.transferId,
        received: inbound.received,
        nextSequence: inbound.writtenSequences,
      })
    ) {
      inbound.lastAcknowledgedBytes = inbound.received;
    }
  }

  private finishOutbound(
    transfer: OutboundTransfer,
    delivered: boolean,
  ): void {
    if (this.outbound !== transfer) return;
    this.clearOutbound(transfer);
    this.callbacks.onFileSent(transfer.offer.messageId, delivered);
  }

  private failOutbound(
    transfer: OutboundTransfer,
    reason: RuntimeCode,
  ): void {
    if (this.outbound !== transfer) return;
    this.clearOutbound(transfer);
    this.callbacks.onFileRejected(transfer.offer.messageId, reason);
  }

  private clearOutbound(transfer = this.outbound): void {
    if (!transfer) return;
    if (transfer.completionTimer) {
      window.clearTimeout(transfer.completionTimer);
      delete transfer.completionTimer;
    }
    if (transfer.ackWaiter) {
      window.clearTimeout(transfer.ackWaiter.timer);
      const waiter = transfer.ackWaiter;
      delete transfer.ackWaiter;
      waiter.reject(new PeerClientError("FILE_CHANNEL_NOT_READY"));
    }
    if (this.outbound === transfer) this.outbound = undefined;
  }

  private discardFileTransfer(messageId: string): void {
    if (this.outbound?.offer.messageId === messageId) {
      this.clearOutbound(this.outbound);
    }
    if (this.inbound?.offer.messageId === messageId) {
      const inbound = this.inbound;
      this.inbound = undefined;
      void this.discardInbound(inbound);
    }
    for (const [transferId, offer] of this.pendingOffers) {
      if (offer.messageId === messageId) {
        this.pendingOffers.delete(transferId);
      }
    }
  }

  private async discardInbound(inbound: InboundTransfer): Promise<void> {
    try {
      await inbound.writeChain;
    } catch {
      // A write already in flight may fail as cancellation starts.
    }
    try {
      await inbound.receiveTarget?.writable.abort(
        "FILE_TRANSFER_CANCELLED",
      );
    } catch {
      // The writable may already have closed or aborted.
    }
    await removeTemporaryFileReceiveTarget(
      inbound.receiveTarget?.temporary,
    );
  }

  private async failInbound(inbound: InboundTransfer): Promise<void> {
    if (this.inbound !== inbound) return;
    this.inbound = undefined;
    try {
      await inbound.receiveTarget?.writable.abort("FILE_WRITE_FAILED");
    } catch {
      // The file may already have been closed by the browser.
    }
    await removeTemporaryFileReceiveTarget(
      inbound.receiveTarget?.temporary,
    );
    this.sendData({
      type: "file_reject",
      transferId: inbound.offer.transferId,
      reason: "FILE_WRITE_FAILED",
    });
    this.callbacks.onFileRejected(
      inbound.offer.messageId,
      "fileWriteFailed",
    );
  }

  private handleFileChannelFailure(channel: RTCDataChannel): void {
    if (this.fileChannel !== channel) return;
    this.fileChannel = undefined;
    if (this.outbound) {
      this.failOutbound(this.outbound, "fileChannelClosed");
    }
    if (this.inbound) {
      void this.failInbound(this.inbound);
    }
  }

  private sendData(message: DataMessage): boolean {
    if (this.controlChannel?.readyState !== "open") return false;
    this.controlChannel.send(JSON.stringify(message));
    return true;
  }

  private async handleConversationDeleteRequest(
    requestId: string,
  ): Promise<void> {
    await this.prepareConversationDeletion();
    let deleted = false;
    try {
      deleted = await this.callbacks.onConversationDelete();
    } catch {
      deleted = false;
    }
    if (deleted) this.conversationDeleted = true;
    this.sendData({
      type: "conversation_delete_result",
      requestId,
      deleted,
    });
  }

  private async discardAllFileTransfers(): Promise<void> {
    this.pendingOffers.clear();
    if (this.outbound) {
      const outbound = this.outbound;
      this.clearOutbound(outbound);
      this.callbacks.onFileCancelled(outbound.offer.messageId);
    }
    if (this.inbound) {
      const inbound = this.inbound;
      this.inbound = undefined;
      await this.discardInbound(inbound);
      this.callbacks.onFileCancelled(inbound.offer.messageId);
    }
  }

  private clearPendingMessageDeletes(reportFailure: boolean): void {
    for (const pending of this.pendingMessageDeletes.values()) {
      window.clearTimeout(pending.timer);
      if (reportFailure) {
        this.callbacks.onMessageDeleteResult(
          pending.messageId,
          false,
        );
      }
    }
    this.pendingMessageDeletes.clear();
  }

  private clearPendingConversationDeletes(): void {
    for (const pending of this.pendingConversationDeletes.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingConversationDeletes.clear();
  }

  private sendWs(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendRtcSignal(signal: RtcSignal): boolean {
    if (
      this.signalingTransport === "data" &&
      this.sendData({ type: "rtc_signal", signal })
    ) {
      return true;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "signal", signal }));
      return true;
    }
    return false;
  }

  private resetPeerConnection(): void {
    this.stopHeartbeat();
    this.clearConnectionTimers();
    this.stopSelectedPairMonitor();
    this.cancelRelayUpgrade();
    this.cancelAddressProbe();
    if (this.inbound) {
      void this.failInbound(this.inbound);
    }
    if (this.outbound) {
      this.failOutbound(this.outbound, "fileChannelClosed");
    }
    this.pendingOffers.clear();

    const controlChannel = this.controlChannel;
    const fileChannel = this.fileChannel;
    const pc = this.pc;
    this.controlChannel = undefined;
    this.fileChannel = undefined;
    this.pc = undefined;
    controlChannel?.close();
    fileChannel?.close();
    pc?.close();

    this.queuedCandidates = [];
    this.iceRestartAttempts = 0;
    this.iceRestartPending = false;
    this.signalingTransport = "ws";
    this.clearConnectionRoute();
  }

  private async rebuildPeerConnection(): Promise<void> {
    this.callbacks.onStatus("reconnecting", "connectionInterrupted");
    this.resetPeerConnection();
    await this.preparePeerConnection();
  }

  private clearConnectionTimers(): void {
    if (this.connectionTimer) window.clearTimeout(this.connectionTimer);
    if (this.disconnectedTimer) window.clearTimeout(this.disconnectedTimer);
    this.connectionTimer = undefined;
    this.disconnectedTimer = undefined;
  }

  private armConnectionTimer(pc: RTCPeerConnection): void {
    if (this.connectionTimer) window.clearTimeout(this.connectionTimer);
    this.connectionTimer = window.setTimeout(() => {
      this.connectionTimer = undefined;
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.iceRestartAttempts = 0;
        this.iceRestartPending = false;
        return;
      }
      this.iceRestartPending = false;
      void this.attemptIceRestart(pc);
    }, CONNECTION_ATTEMPT_TIMEOUT_MS);
  }

  private relayUpgradeState() {
    return {
      role: this.role,
      online: this.isOnline,
      relayOnly: this.relayOnly,
      ...(this.customPeerIp
        ? { customPeerIp: this.customPeerIp }
        : {}),
      ...(this.localConnectionRoute
        ? { route: this.localConnectionRoute }
        : {}),
      iceServers: this.iceServers,
    };
  }

  private scheduleRelayUpgrade(
    delay = relayUpgradeDelay(this.relayUpgradeAttempts),
    force = false,
  ): void {
    if (this.relayUpgradeTimer || this.relayUpgradePending) return;
    if (
      force
        ? this.role !== "host" ||
          !this.isOnline ||
          Boolean(this.customPeerIp)
        : !shouldScheduleRelayUpgrade(this.relayUpgradeState())
    ) {
      return;
    }
    this.relayUpgradeTimer = window.setTimeout(() => {
      this.relayUpgradeTimer = undefined;
      void this.startInBandIceRestart(force);
    }, delay);
  }

  private cancelRelayUpgrade(resetAttempts = true): void {
    if (this.relayUpgradeTimer) {
      window.clearTimeout(this.relayUpgradeTimer);
      this.relayUpgradeTimer = undefined;
    }
    this.relayUpgradePending = false;
    if (resetAttempts) this.relayUpgradeAttempts = 0;
  }

  private async startInBandIceRestart(force = false): Promise<void> {
    const pc = this.pc;
    if (
      !pc ||
      this.role !== "host" ||
      !this.isOnline ||
      Boolean(this.customPeerIp) ||
      this.relayUpgradePending ||
      (!force &&
        !shouldScheduleRelayUpgrade(this.relayUpgradeState()))
    ) {
      return;
    }
    if (pc.signalingState !== "stable") {
      this.scheduleRelayUpgrade(2_000, force);
      return;
    }
    if (
      !force &&
      (this.outbound || this.inbound || this.pendingOffers.size > 0)
    ) {
      this.scheduleRelayUpgrade(
        RELAY_UPGRADE_TRANSFER_DEFERRAL_MS,
      );
      return;
    }

    this.relayUpgradePending = true;
    if (!force) this.relayUpgradeAttempts += 1;
    this.signalingTransport = "data";
    try {
      pc.setConfiguration(
        rtcConfiguration(this.iceServers, this.relayOnly),
      );
      pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      if (!this.sendDescription(pc.localDescription!)) {
        throw new Error("CONTROL_CHANNEL_NOT_READY");
      }
      this.relayUpgradeTimer = window.setTimeout(() => {
        this.relayUpgradeTimer = undefined;
        this.relayUpgradePending = false;
        this.scheduleRelayUpgrade();
      }, RELAY_UPGRADE_SETTLE_MS);
    } catch {
      this.relayUpgradePending = false;
      if (!force) this.scheduleRelayUpgrade();
    }
  }

  private async attemptIceRestart(pc: RTCPeerConnection): Promise<void> {
    if (
      this.pc !== pc ||
      pc.connectionState === "closed" ||
      this.iceRestartPending
    ) {
      return;
    }
    if (
      this.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS ||
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      this.failDirectConnection(pc);
      return;
    }

    this.iceRestartAttempts += 1;
    this.iceRestartPending = true;
    this.signalingTransport = "ws";
    this.callbacks.onStatus("reconnecting", "connectionInterrupted");
    this.armConnectionTimer(pc);

    try {
      if (this.role === "host") {
        pc.restartIce();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        this.sendDescription(pc.localDescription!);
      } else {
        this.sendWs({
          type: "signal",
          signal: { kind: "restart_request" },
        });
      }
    } catch {
      this.iceRestartPending = false;
      if (this.connectionTimer) {
        window.clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
      }
      if (this.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
        this.failDirectConnection(pc);
      } else {
        this.armConnectionTimer(pc);
      }
    }
  }

  private failDirectConnection(pc: RTCPeerConnection): void {
    if (this.pc !== pc) return;
    this.clearConnectionTimers();
    this.stopSelectedPairMonitor();
    this.cancelRelayUpgrade();
    this.cancelAddressProbe();
    this.clearConnectionRoute();
    const failure = directConnectionFailureCode(this.customPeerIp);
    this.callbacks.onStatus("failed", failure);
    if (this.customPeerIp) this.callbacks.onError(failure);
    this.pc = undefined;
    pc.close();
  }

  private startSelectedPairMonitor(pc: RTCPeerConnection): void {
    this.stopSelectedPairMonitor();
    const transport = pc.sctp?.transport.iceTransport;
    const listener = () => {
      void this.updateSelectedRoute(pc, transport);
    };
    if (transport) {
      this.selectedPairTransport = transport;
      transport.addEventListener("selectedcandidatepairchange", listener);
    }
    this.selectedPairListener = listener;
    listener();
  }

  private stopSelectedPairMonitor(): void {
    if (this.selectedPairTransport && this.selectedPairListener) {
      this.selectedPairTransport.removeEventListener(
        "selectedcandidatepairchange",
        this.selectedPairListener,
      );
    }
    if (this.selectedPairRetryTimer) {
      window.clearTimeout(this.selectedPairRetryTimer);
      this.selectedPairRetryTimer = undefined;
    }
    this.selectedPairTransport = undefined;
    this.selectedPairListener = undefined;
    this.selectedPairRetryAttempts = 0;
  }

  private emitPublicAddresses(): void {
    const addresses = [...this.publicAddresses].sort((left, right) => {
        const leftIsV6 = left.includes(":");
        const rightIsV6 = right.includes(":");
        if (leftIsV6 === rightIsV6) return left.localeCompare(right);
        return leftIsV6 ? 1 : -1;
      });
    if (this.selectedPublicAddress) {
      const selectedIndex = addresses.indexOf(this.selectedPublicAddress);
      if (selectedIndex > 0) {
        addresses.splice(selectedIndex, 1);
        addresses.unshift(this.selectedPublicAddress);
      }
    }
    this.callbacks.onPublicAddresses({
      addresses,
      freshness: this.publicAddressFreshness,
      hasHostCandidate: this.hasHostCandidate,
      hasMaskedLanCandidate: this.hasMaskedLanCandidate,
    });
  }

  private markAddressesCached(): void {
    this.publicAddressFreshness =
      this.publicAddresses.size > 0 ? "cached" : "unavailable";
    this.emitPublicAddresses();
  }

  private publishAddressDiscovery(
    generation: number,
    discovered: Set<string>,
    hasHostCandidate: boolean,
    hasMaskedLanCandidate: boolean,
  ): void {
    if (generation !== this.addressProbeGeneration) return;
    this.hasHostCandidate = hasHostCandidate;
    this.hasMaskedLanCandidate = hasMaskedLanCandidate;
    if (discovered.size > 0) {
      this.publicAddresses = new Set(discovered);
      this.publicAddressFreshness = "current";
      saveCachedIceAddresses([...this.publicAddresses]);
    } else if (this.publicAddresses.size === 0) {
      this.publicAddressFreshness = "unavailable";
    }
    this.emitPublicAddresses();
  }

  private beginAddressProbe(generation: number): void {
    if (this.addressProbeTimer) {
      window.clearTimeout(this.addressProbeTimer);
    }
    this.callbacks.onAddressProbeState(true);
    this.addressProbeTimer = window.setTimeout(() => {
      this.finishAddressProbe(generation);
    }, 9_000);
  }

  private finishAddressProbe(generation: number): void {
    if (generation !== this.addressProbeGeneration) return;
    if (this.addressProbeTimer) {
      window.clearTimeout(this.addressProbeTimer);
      this.addressProbeTimer = undefined;
    }
    this.callbacks.onAddressProbeState(false);
  }

  private cancelAddressProbe(): void {
    this.addressProbeGeneration += 1;
    if (this.addressProbeTimer) {
      window.clearTimeout(this.addressProbeTimer);
      this.addressProbeTimer = undefined;
    }
    this.callbacks.onAddressProbeState(false);
  }

  private async updateSelectedRoute(
    pc: RTCPeerConnection,
    transport: RTCIceTransport | undefined,
  ): Promise<void> {
    let pair:
      | {
          local: {
            address: string | null;
            type: RTCIceCandidateType | null;
            protocol: RTCIceProtocol | null;
          };
          remote: {
            address: string | null;
            type: RTCIceCandidateType | null;
            protocol: RTCIceProtocol | null;
          };
        }
      | undefined;
    try {
      const getSelectedPair = transport?.getSelectedCandidatePair;
      const transportPair =
        typeof getSelectedPair === "function"
          ? getSelectedPair.call(transport)
          : undefined;
      if (transportPair) {
        pair = {
          local: transportPair.local,
          remote: transportPair.remote,
        };
      }
    } catch {
      // Safari and older mobile engines may expose an incomplete transport API.
    }
    if (!pair) {
      try {
        pair = selectedCandidatePairFromStats(await pc.getStats());
      } catch {
        // Retry briefly below while the selected pair settles.
      }
    }
    if (this.pc !== pc) return;
    if (!pair) {
      if (this.selectedPairRetryAttempts >= 8) return;
      this.selectedPairRetryAttempts += 1;
      if (this.selectedPairRetryTimer) {
        window.clearTimeout(this.selectedPairRetryTimer);
      }
      this.selectedPairRetryTimer = window.setTimeout(() => {
        this.selectedPairRetryTimer = undefined;
        void this.updateSelectedRoute(pc, transport);
      }, Math.min(1_000, 150 * this.selectedPairRetryAttempts));
      return;
    }
    if (this.selectedPairRetryTimer) {
      window.clearTimeout(this.selectedPairRetryTimer);
      this.selectedPairRetryTimer = undefined;
    }
    this.selectedPairRetryAttempts = 0;
    const route = connectionRouteFromCandidates(pair.local, pair.remote);
    this.localConnectionRoute = route;
    this.publishConnectionRoute();
    this.sendConnectionRoute();
    if (
      route.kind === "relay" ||
      route.localCandidateType === "relay"
    ) {
      this.scheduleRelayUpgrade();
      return;
    }
    this.cancelRelayUpgrade();
    if (!route.localAddress) return;
    this.selectedPublicAddress = route.localAddress;
    this.publicAddresses.add(route.localAddress);
    this.publicAddressFreshness = "current";
    saveCachedIceAddresses([...this.publicAddresses]);
    this.emitPublicAddresses();
  }

  private publishConnectionRoute(): void {
    this.callbacks.onConnectionRoute(
      reconcileConnectionRoutes(
        this.localConnectionRoute,
        this.remoteConnectionRoute,
      ),
    );
  }

  private sendConnectionRoute(): void {
    const route = this.localConnectionRoute;
    if (!route) return;
    this.sendData({
      type: "connection_route",
      kind: route.kind,
      ...(route.protocol ? { protocol: route.protocol } : {}),
    });
  }

  private clearConnectionRoute(): void {
    this.localConnectionRoute = undefined;
    this.remoteConnectionRoute = undefined;
    this.callbacks.onConnectionRoute(undefined);
  }
}
