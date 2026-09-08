import {
  createRoomResponseSchema,
  dataMessageSchema,
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
  MAX_QUEUED_FILES,
  type FileReceiveMode,
  fileChunkSize,
  removeTemporaryFileReceiveTarget,
  retainTemporaryFileReceiveTarget,
  type WritableFileReceiveTarget,
} from "../file-transfer";
import { canRestoreExistingPeerConnection } from "../network-recovery";
import {
  relayUpgradeDelay,
  shouldScheduleRelayUpgrade,
} from "../relay-upgrade";
import { rtcConfiguration } from "../rtc-config";
import { PeerClientError } from "./peer-client-error";
import { fetchJson } from "./fetch-json";
import { connectionIsBusy } from "./connection-state";
import { RemoteIceCandidates } from "./remote-ice-candidates";
import { SignalingHandover } from "./signaling-handover";
import { candidateFields, descriptionFields, diagnosticDetail, rtcErrorFields, type DiagnosticFields } from "./connection-diagnostics";
import type {
  ApiConfig,
  ConnectionStatus,
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
const CONNECTION_TOTAL_TIMEOUT_MS = CONNECTION_ATTEMPT_TIMEOUT_MS * (MAX_ICE_RESTART_ATTEMPTS + 1);
const SIGNALING_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const HEARTBEAT_PROBE_TIMEOUT_MS = 5_000;
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
const PREVIOUS_PATH_RETENTION_MS = 30_000;
const PREVIOUS_PATH_PROBE_MS = 1_500;
function addUsableAddress(
  addresses: Set<string>,
  address: string | null | undefined,
): void {
  const usableAddress = usableConnectionAddress(address || undefined);
  if (usableAddress) addresses.add(usableAddress);
}

export class PeerClient {
  private status: ConnectionStatus = "offline";
  private readonly diagnosticClientId = crypto.randomUUID().slice(0, 8);
  private peerConnectionSequence = 0;
  private diagnostics: ({ at: number; event: string; detail?: string } & DiagnosticFields)[] = [];
  private ws: WebSocket | undefined;
  private pc: RTCPeerConnection | undefined;
  private controlChannel: RTCDataChannel | undefined;
  private fileChannel: RTCDataChannel | undefined;
  private role: "host" | "guest" | undefined;
  private code: string | undefined;
  private shareToken: string | undefined;
  private connectionToken: string | undefined;
  private restoringKnownPeer = false;
  private peer: DeviceIdentity | undefined;
  private connectedNotified = false;
  private conversationDeleted = false;
  private signalingConsumed = false;
  private signalingTransport: "ws" | "data" = "ws";
  private signalingCloseExpected = false;
  private serverTerminalMessageReceived = false;
  private remoteCandidates = new RemoteIceCandidates();
  private heartbeat: number | undefined;
  private connectionTimer: number | undefined;
  private connectionDeadlineTimer: number | undefined;
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
  private addressProbe: { promise: Promise<void>; cancel: () => void } | undefined;
  private iceServers: RTCIceServer[];
  private relayOnly: boolean;
  private relayUpgradeTimer: number | undefined;
  private relayUpgradeAttempts = 0;
  private relayUpgradePending = false;
  private operationGeneration = 0;
  private requestAbort: AbortController | undefined;
  private signalingTimer: number | undefined;
  private networkAvailable = true;
  private lastHeartbeatTickAt = 0;
  private lastPingAt = 0;
  private heartbeatProbe: { at: number; timer: number } | undefined;
  private sessionId: string | undefined;
  private parked = false;
  private parkedTimer: number | undefined;
  private parkedUntil = 0;
  private reuseProbe: { at: number; timer: number; resolve: (reused: boolean) => void; resent: boolean } | undefined;
  private policyChangePending = false;
  private policyNegotiated = false;
  private policyChangeTimer: number | undefined;
  private policyCheckTimer: number | undefined;
  private iceConfigurationGeneration = 0;
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
  private outboundQueue: OutboundTransfer[] = [];
  private inbound: InboundTransfer | undefined;
  private readonly signalingHandover = new SignalingHandover({
    ready: () => this.signalingConsumed && this.isOnline &&
      this.ws?.readyState === WebSocket.OPEN && this.fileChannel?.readyState === "open" &&
      this.pc?.iceGatheringState === "complete" && this.pc.signalingState === "stable" &&
      !this.iceRestartPending && !this.policyChangePending,
    nextNonce: () => this.nextPingAt(),
    ping: at => this.sendData({ type: "ping", at }),
    release: () => {
      this.signalingTransport = "data";
      this.sendWs({ type: "signaling_stable" });
    },
  });

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
    return this.hasConnectedTransport && !this.isCheckingConnection;
  }

  get isConnecting(): boolean {
    return connectionIsBusy(this.status);
  }

  getConnectionDiagnostics() {
    return this.diagnostics.map(entry => ({ ...entry }));
  }

  private recordDiagnostic(event: string, detail?: string, fields: DiagnosticFields = {}, level: "info" | "warn" = "info"): void {
    const safeDetail = diagnosticDetail(detail);
    const entry = {
      at: Date.now(), client: this.diagnosticClientId, attempt: this.operationGeneration,
      connection: this.peerConnectionSequence, event, ...(safeDetail ? { detail: safeDetail } : {}),
      role: this.role, status: this.status, signaling: this.pc?.signalingState,
      ice: this.pc?.iceConnectionState, gathering: this.pc?.iceGatheringState,
      transport: this.signalingTransport, ...fields,
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 200) this.diagnostics.shift();
    console[level]("[Peerto connection]", JSON.stringify(entry));
  }

  private async rtcOperation<T>(operation: string, pc: RTCPeerConnection, run: () => Promise<T>, fields: DiagnosticFields = {}): Promise<T> {
    const started = Date.now();
    const context = { ...fields, attempt: this.operationGeneration, connection: this.peerConnectionSequence };
    this.recordDiagnostic(`${operation}_start`, undefined, context);
    try {
      const result = await run();
      this.recordDiagnostic(`${operation}_ok`, undefined, { ...context, elapsedMs: Date.now() - started, stale: this.pc !== pc });
      return result;
    } catch (error) {
      this.recordDiagnostic(`${operation}_failed`, undefined, {
        ...context, ...rtcErrorFields(error), elapsedMs: Date.now() - started, stale: this.pc !== pc,
      }, "warn");
      throw error;
    }
  }

  private setStatus(status: ConnectionStatus, detail?: RuntimeCode): void {
    this.status = status;
    this.recordDiagnostic(status, detail, {}, status === "failed" ? "warn" : "info");
    this.callbacks.onStatus(status, detail);
  }

  get isCheckingConnection(): boolean {
    return Boolean(this.heartbeatProbe) || this.policyChangePending;
  }

  private get hasConnectedTransport(): boolean {
    return (
      !this.parked &&
      this.networkAvailable &&
      canRestoreExistingPeerConnection(
        this.controlChannel?.readyState,
        this.pc?.connectionState,
      )
    );
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
    if (policyChanged) this.iceConfigurationGeneration += 1;
    if (!pc) return;
    try {
      pc.setConfiguration(
        rtcConfiguration(this.iceServers, this.relayOnly),
      );
    } catch {
      if (policyChanged) this.failPolicyChange();
      else this.callbacks.onError("icePolicyFailed");
      return;
    }
    if (!policyChanged) return;
    if (!this.hasConnectedTransport) {
      // A partially negotiated old policy cannot be reported as applied.
      // The normal reconnect path will create a PC with the new settings.
      this.failPolicyChange();
      return;
    }

    this.cancelRelayUpgrade();
    this.clearPolicyChange();
    this.policyChangePending = true;
    this.setStatus("reconnecting", "icePolicyChanging");
    this.policyChangeTimer = window.setTimeout(() => {
      if (this.pc === pc && this.policyChangePending) this.failPolicyChange();
    }, SIGNALING_TIMEOUT_MS);
    this.signalingTransport = "data";
    if (this.role === "host") {
      void this.startInBandIceRestart(true);
    } else {
      if (!this.sendRtcSignal({ kind: "restart_request" })) {
        this.failPolicyChange();
      }
    }
  }

  setDeviceName(name: string): void {
    this.identity.device = {
      ...this.identity.device,
      name: name.trim().slice(0, 64),
    };
  }

  async refreshPeer(
    target: PeerReconnectTarget,
  ): Promise<"waiting" | "joining" | "reused" | "cancelled"> {
    if (!this.networkAvailable || !navigator.onLine) return "cancelled";
    if (this.isConnecting) return "cancelled";
    if (this.isOnline && this.peer?.deviceId === target.deviceId) return "reused";
    if (this.parked && this.peer?.deviceId === target.deviceId &&
        this.code === target.code && this.connectionToken === target.token) {
      const generation = this.operationGeneration;
      const reused = await this.probePreviousPath();
      if (generation !== this.operationGeneration) return "cancelled";
      if (!this.networkAvailable || !navigator.onLine) {
        this.disconnect(false);
        this.setStatus("network_offline", "networkOffline");
        return "cancelled";
      }
      if (reused) return "reused";
    }
    // A closed/expired transport cannot be reconstructed from a cached IP.
    // Fall back once to fresh credentials and a complete ICE negotiation.
    this.disconnect(false);
    const operationGeneration = this.operationGeneration;
    this.setStatus("reconnecting", "validatingCode");
    try {
      // The authenticated WS pair coordinates the offerer; no REST round trip.
      this.role = "host";
      this.code = target.code;
      this.connectionToken = target.token;
      this.restoringKnownPeer = true;
      this.signalingConsumed = false;
      this.openWebSocket("host", target.code, undefined, target.token,
        this.identity.device.deviceId, target.deviceId, true);
      return "waiting";
    } catch (error) {
      if (operationGeneration !== this.operationGeneration) return "cancelled";
      this.failSignaling(error instanceof PeerClientError
        ? `server.${error.code}` : "signalingUnavailable");
      throw error;
    }
  }

  async startHost(turnstileToken?: string): Promise<void> {
    this.disconnect(false);
    const operationGeneration = this.operationGeneration;
    this.role = "host";
    this.setStatus("signaling", "generatingCode");

    const body: CreateRoomRequest = {
      host: this.identity.device,
      ...(turnstileToken ? { turnstileToken } : {}),
    };
    const result = await this.requestRoom("/api/rooms", body);
    if (!result || operationGeneration !== this.operationGeneration) return;
    const { response, payload } = result;
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
    if (operationGeneration !== this.operationGeneration) return;
    this.openWebSocket(
      "host",
      room.code,
      room.hostToken,
      room.connectionToken,
    );
  }

  join(code: string, shareToken?: string): void {
    this.disconnect(false);
    this.role = "guest";
    this.code = code;
    this.shareToken = shareToken;
    this.connectionToken = undefined;
    this.setStatus("signaling", "validatingCode");
    this.openWebSocket("guest", code);
  }

  acceptPeer(deviceId: string): void {
    this.sendWs({ type: "accept_peer", deviceId });
    this.setStatus("connecting", "establishingP2P");
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
    if (this.outboundQueue.length + (this.outbound ? 1 : 0) >= MAX_QUEUED_FILES) throw new PeerClientError("FILE_QUEUE_FULL");

    const offer: FileOffer = {
      transferId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      createdAt: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };
    const transfer: OutboundTransfer = {
      offer,
      file,
      phase: "offered",
      acknowledgedBytes: 0,
      sentSequences: 0,
    };
    if (this.outbound) {
      this.outboundQueue.push(transfer);
      return offer;
    }
    this.outbound = transfer;
    if (!this.sendData({ type: "file_offer", ...offer })) {
      this.outbound = undefined;
      throw new PeerClientError("FILE_CHANNEL_NOT_READY");
    }
    return offer;
  }

  private advanceOutboundQueue(): void {
    if (this.outbound) return;
    const next = this.outboundQueue.shift();
    if (!next) return;
    this.outbound = next;
    if (!this.isOnline || this.fileChannel?.readyState !== "open" ||
        !this.sendData({ type: "file_offer", ...next.offer })) {
      this.failFileTransfers();
    }
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
    this.clearPreviousPath();
    this.sessionId = undefined;
    this.status = "offline";
    this.operationGeneration += 1;
    this.requestAbort?.abort();
    this.requestAbort = undefined;
    this.clearSignalingTimer();
    this.resetPeerConnection(notify);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    this.peer = undefined;
    this.shareToken = undefined;
    this.connectionToken = undefined;
    this.restoringKnownPeer = false;
    this.conversationDeleted = false;
    this.signalingConsumed = false;
    this.signalingCloseExpected = false;
    this.serverTerminalMessageReceived = false;
    this.markAddressesCached();
    if (notify) this.setStatus("offline", "ready");
  }

  setNetworkAvailable(
    online: boolean,
    probeAddresses = false,
  ): void {
    this.networkAvailable = online;
    this.markAddressesCached();
    if (!online) {
      // A published offline state is terminal. Network/visibility events may
      // probe a still-live session, but may never resurrect an offline one.
      this.parkPreviousPath();
      this.setStatus("network_offline", "networkOffline");
      return;
    }
    if (this.parked) {
      if (!this.reuseProbe) this.setStatus("offline", "networkRestored");
    } else if (this.pc) {
      this.checkConnectionAfterResume();
    } else if (!this.isConnecting) {
      this.setStatus("offline", "networkRestored");
    }
    if (probeAddresses) void this.probePublicAddresses();
  }

  checkConnectionAfterResume(): void {
    if (!this.networkAvailable || !this.pc || this.parked) return;
    if (this.hasConnectedTransport) {
      this.beginHeartbeatProbe();
    } else if (
      this.connectionTimer || this.disconnectedTimer || this.isCheckingConnection
    ) {
      // Visibility events must not preempt a bounded setup or ICE recovery.
      return;
    } else {
      this.parkPreviousPath();
      this.setStatus("offline", "connectionInterrupted");
    }
  }

  probePublicAddresses(): Promise<void> {
    if (!this.networkAvailable || !navigator.onLine || this.pc || this.isConnecting) return Promise.resolve();
    if (this.addressProbe) return this.addressProbe.promise;
    const controller = new AbortController();
    const task = { promise: Promise.resolve(), cancel: () => controller.abort() };
    this.addressProbe = task;
    task.promise = this.gatherPublicAddresses(controller.signal).finally(() => {
      if (this.addressProbe === task) this.addressProbe = undefined;
    });
    return task.promise;
  }

  invalidatePublicAddresses(): void {
    if (this.addressProbe) this.cancelAddressProbe();
    this.markAddressesCached();
  }

  private async gatherPublicAddresses(signal: AbortSignal): Promise<void> {
    const generation = ++this.addressProbeGeneration;
    this.beginAddressProbe(generation);
    this.selectedPublicAddress = undefined;
    this.hasHostCandidate = false;
    this.hasMaskedLanCandidate = false;
    this.markAddressesCached();
    let probe: RTCPeerConnection | undefined;
    const closeProbe = () => {
      const previous = probe;
      probe = undefined;
      previous?.close();
    };
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
      signal.addEventListener("abort", closeProbe, { once: true });
      probe.createDataChannel("ip-probe");

      await new Promise<void>((resolve) => {
        const finish = () => {
          window.clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => { closeProbe(); finish(); };
        const timer = window.setTimeout(finish, 8_000);
        signal.addEventListener("abort", cancel, { once: true });
        probe?.addEventListener("icecandidate", (event) => {
          if (signal.aborted || !probe || generation !== this.addressProbeGeneration) return;
          if (!event.candidate) {
            finish();
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
          .then((offer) => {
            if (!signal.aborted && generation === this.addressProbeGeneration) return probe?.setLocalDescription(offer);
          })
          .catch(finish);
      });

      if (signal.aborted || generation !== this.addressProbeGeneration || !probe) return;
      try {
        const activeProbe = probe;
        const stats = await new Promise<RTCStatsReport | undefined>(resolve => {
          const finish = (report?: RTCStatsReport) => {
            window.clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            resolve(report);
          };
          const cancel = () => finish();
          const timer = window.setTimeout(cancel, 1_000);
          signal.addEventListener("abort", cancel, { once: true });
          void activeProbe.getStats().then(finish, cancel);
        });
        if (signal.aborted || generation !== this.addressProbeGeneration) return;
        stats?.forEach((report) => {
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
      signal.removeEventListener("abort", closeProbe);
      closeProbe();
      this.finishAddressProbe(generation);
    }
  }

  private async requestRoom(url: string, body: unknown) {
    const generation = this.operationGeneration;
    const controller = new AbortController();
    this.requestAbort = controller;
    try {
      const result = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, 10_000);
      return generation === this.operationGeneration ? result : undefined;
    } catch (error) {
      if (generation !== this.operationGeneration) return undefined;
      throw error;
    } finally {
      if (this.requestAbort === controller) this.requestAbort = undefined;
    }
  }

  private clearSignalingTimer(): void {
    if (this.signalingTimer) window.clearTimeout(this.signalingTimer);
    this.signalingTimer = undefined;
  }

  private armSignalingTimer(
    ws: WebSocket,
    timeoutMs = SIGNALING_TIMEOUT_MS,
    failure: RuntimeCode = "signalingTimeout",
  ): void {
    this.clearSignalingTimer();
    this.signalingTimer = window.setTimeout(() => {
      if (this.ws !== ws) return;
      this.recordDiagnostic("ws_timeout", failure, { timeoutMs }, "warn");
      this.failSignaling(failure);
    }, Math.max(1, timeoutMs));
  }

  private failSignaling(failure: RuntimeCode): void {
    this.disconnect(false);
    this.setStatus("failed", failure);
  }

  private openWebSocket(
    role: "host" | "guest",
    code: string,
    token?: string,
    connectionToken?: string,
    deviceId?: string,
    peerDeviceId?: string,
    registerRecovery = false,
  ): void {
    this.recordDiagnostic("ws_connect", registerRecovery ? "recovery" : "pairing");
    const ws = new WebSocket(websocketUrl(role, code));
    this.ws = ws;
    this.signalingTransport = "ws";
    this.signalingCloseExpected = false;
    this.serverTerminalMessageReceived = false;
    const generation = this.operationGeneration;
    const isCurrent = () =>
      this.ws === ws && this.operationGeneration === generation;
    this.armSignalingTimer(ws);
    let messages = Promise.resolve();

    ws.addEventListener("open", () => {
      if (!isCurrent()) return;
      this.recordDiagnostic("ws_open");
      const init: WsSessionInit = {
        type: "session_init",
        ...(token ? { token } : {}),
        ...(connectionToken ? { connectionToken } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(peerDeviceId ? { peerDeviceId } : {}),
        ...(registerRecovery ? { recoveryDevice: this.identity.device } : {}),
      };
      ws.send(JSON.stringify(init));
    });
    ws.addEventListener("message", (event) => {
      // Serialize SDP and ICE messages, including asynchronous key signing.
      messages = messages.then(async () => {
        if (isCurrent()) {
          await this.handleServerMessage(event.data, ws, generation);
        }
      }).catch((error) => {
        this.recordDiagnostic("ws_message_failed", undefined, { ...rtcErrorFields(error), stale: !isCurrent() }, "warn");
        if (isCurrent()) this.failSignaling("signalingUnavailable");
      });
    });
    ws.addEventListener("error", () => {
      if (!isCurrent()) return;
      this.recordDiagnostic("ws_error", undefined, { readyState: ws.readyState }, "warn");
      // A consumed signaling service is not required by a working P2P link.
      if (this.hasConnectedTransport) {
        this.ws = undefined;
        this.clearSignalingTimer();
        this.signalingTransport = "data";
        this.signalingConsumed = true;
        ws.close();
        return;
      }
      this.callbacks.onError("signalingUnavailable");
      this.failSignaling("signalingUnavailable");
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.recordDiagnostic("ws_close", undefined, { closeCode: event.code, clean: event.wasClean, expected: this.signalingCloseExpected });
      this.ws = undefined;
      this.clearSignalingTimer();
      this.signalingHandover.cancel();
      if (this.hasConnectedTransport) this.signalingTransport = "data";
      if (this.signalingCloseExpected) return;
      if (this.hasConnectedTransport) {
        this.signalingTransport = "data";
        this.signalingConsumed = true;
        return;
      }
      if (this.peer && !this.serverTerminalMessageReceived) {
        this.disconnect(false);
        this.setStatus("offline", "peerOffline");
        return;
      }
      if (!this.isOnline && !this.signalingConsumed) {
        this.failSignaling("signalingDisconnected");
      }
    });
  }

  private async handleServerMessage(
    raw: unknown,
    ws: WebSocket,
    generation: number,
  ): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      this.recordDiagnostic("ws_invalid_json", undefined, {}, "warn");
      this.callbacks.onError("invalidServerMessage");
      return;
    }
    const parsed = serverWsMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.recordDiagnostic("ws_invalid_schema", undefined, {}, "warn");
      this.callbacks.onError("incompatibleServerMessage");
      return;
    }

    const message = parsed.data;
    if (message.type !== "signal") this.recordDiagnostic("ws_receive", message.type);
    if (message.type === "challenge") {
      if (!this.code) return;
      this.setStatus("authenticating", "validatingIdentity");
      const signature = await signChallenge(
        this.identity.keyPair.privateKey,
        this.code,
        message.challenge,
      );
      if (this.ws !== ws || this.operationGeneration !== generation) return;
      this.sendWs({
        type: "authenticate",
        device: this.identity.device,
        signature,
        ...(this.shareToken ? { shareToken: this.shareToken } : {}),
        ...(this.connectionToken
          ? { connectionToken: this.connectionToken }
          : {}),
      });
      if (this.role === "guest" && !this.restoringKnownPeer) {
        this.armSignalingTimer(ws, this.config.roomTtlSeconds * 1_000, "codeExpired");
      }
    } else if (message.type === "room_ready") {
      if (this.restoringKnownPeer || this.sessionId) {
        this.resetPeerConnection();
        this.sessionId = undefined;
        this.role = "host";
        this.restoringKnownPeer = true;
      }
      this.armSignalingTimer(ws, message.expiresAt - Date.now(), "codeExpired");
      this.setStatus(
        "waiting",
        this.restoringKnownPeer ? "waitingForKnownPeer" : "codeReady",
      );
    } else if (message.type === "join_request") {
      this.callbacks.onJoinRequest(message.device);
    } else if (message.type === "peer_accepted") {
      if (message.sessionId && message.sessionId === this.sessionId) return;
      if (this.pc) this.resetPeerConnection();
      this.sessionId = message.sessionId;
      this.role = message.rendezvous.role;
      this.clearSignalingTimer();
      const restored = this.restoringKnownPeer;
      this.peer = message.peer;
      this.connectionToken = message.rendezvous.token;
      this.restoringKnownPeer = false;
      this.callbacks.onPeer(
        message.peer,
        message.rendezvous,
        restored,
      );
      if (this.ws !== ws || this.operationGeneration !== generation) return;
      this.setStatus("connecting", "negotiatingP2P");
      await this.preparePeerConnection();
    } else if (message.type === "peer_rejected") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      this.failSignaling("peerRejected");
    } else if (message.type === "signal") {
      if (message.sessionId !== this.sessionId) {
        this.recordDiagnostic("signal_stale_session", message.signal.kind);
        return;
      }
      await this.handleSignal(message.signal, "ws");
      this.signalingHandover.update();
    } else if (message.type === "room_consumed") {
      this.clearSignalingTimer();
      this.signalingConsumed = true;
      this.signalingCloseExpected = true;
      this.signalingHandover.update();
    } else if (message.type === "room_closed") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      const reasons: Record<typeof message.reason, RuntimeCode> = {
        expired: "codeExpired",
        host_offline: "hostOffline",
        ip_changed: "connectionIpChanged",
        invalid_code: "invalidCode",
        replaced: "connectionReplaced",
      };
      if ((message.reason === "host_offline" || message.reason === "expired") && this.hasConnectedTransport) {
        this.clearSignalingTimer();
        this.signalingCloseExpected = true;
        this.recordDiagnostic("signaling_closed", message.reason);
        this.beginHeartbeatProbe();
      } else {
        this.failSignaling(reasons[message.reason]);
      }
    } else if (message.type === "error") {
      this.serverTerminalMessageReceived = true;
      this.signalingConsumed = true;
      const code = `server.${message.code}` as RuntimeCode;
      this.failSignaling(code);
      this.callbacks.onError(code);
    }
  }

  private async preparePeerConnection(): Promise<void> {
    if (this.pc) return;
    this.cancelAddressProbe();
    const generation = this.operationGeneration;
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
        rtcConfiguration(this.iceServers, this.relayOnly),
      );
    } catch (error) {
      this.finishAddressProbe(addressProbeGeneration);
      throw error;
    }
    this.pc = pc;
    this.peerConnectionSequence += 1;
    this.recordDiagnostic("pc_created", undefined, { relayOnly: this.relayOnly, iceServerCount: this.iceServers.length });
    pc.addEventListener("icecandidateerror", (event) => {
      if (this.pc !== pc) return;
      // Do not retain candidate addresses, server URLs, SDP or credentials.
      const urls = this.iceServers.flatMap(server => server.urls);
      this.recordDiagnostic("ice_candidate_error", undefined, { errorCode: event.errorCode, serverIndex: urls.indexOf(event.url) }, "warn");
    });

    pc.addEventListener("icecandidate", (event) => {
      if (this.pc !== pc || !this.networkAvailable) return;
      if (!event.candidate) {
        this.recordDiagnostic("ice_gathering_complete");
        this.publishAddressDiscovery(
          addressProbeGeneration,
          discovered,
          hasHostCandidate,
          hasMaskedLanCandidate,
        );
        this.finishAddressProbe(addressProbeGeneration);
        return;
      }
      this.recordDiagnostic("local_candidate", undefined, candidateFields(event.candidate));
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
      if (this.pc !== pc) return;
      this.recordDiagnostic("ice_gathering_state");
      if (pc.iceGatheringState === "complete") {
        this.finishAddressProbe(addressProbeGeneration);
      }
      this.signalingHandover.update();
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (this.pc === pc) this.recordDiagnostic("ice_connection_state", undefined, {}, pc.iceConnectionState === "failed" ? "warn" : "info");
    });
    pc.addEventListener("signalingstatechange", () => {
      if (this.pc === pc) this.recordDiagnostic("sdp_signaling_state");
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc === pc) this.recordDiagnostic("pc_connection_state", pc.connectionState);
      if (this.pc !== pc || !this.networkAvailable || this.parked) return;
      this.signalingHandover.cancel();
      if (pc.connectionState === "connected") {
        this.finishAddressProbe(addressProbeGeneration);
        this.startSelectedPairMonitor(pc);
        this.markOnline();
      } else if (pc.connectionState === "failed") {
        this.stopHeartbeat();
        this.cancelRelayUpgrade();
        this.stopSelectedPairMonitor();
        this.clearConnectionRoute();
        this.setStatus("reconnecting", "connectionInterrupted");
        void this.attemptIceRestart(pc);
      } else if (pc.connectionState === "closed") {
        this.disconnect(false);
        this.setStatus("offline", "peerOffline");
      } else if (pc.connectionState === "disconnected") {
        this.cancelRelayUpgrade();
        this.clearConnectionRoute();
        this.setStatus("reconnecting", "connectionInterrupted");
        if (this.disconnectedTimer) {
          window.clearTimeout(this.disconnectedTimer);
        }
        this.disconnectedTimer = window.setTimeout(() => {
          if (
            this.pc === pc && this.networkAvailable &&
            pc.connectionState === "disconnected"
          ) {
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
      const offer = await this.rtcOperation("sdp_create_offer", pc, () => pc.createOffer());
      if (this.pc !== pc || generation !== this.operationGeneration) return;
      await this.rtcOperation("sdp_set_local", pc, () => pc.setLocalDescription(offer), descriptionFields(offer));
      if (this.pc !== pc || generation !== this.operationGeneration) return;
      this.sendDescription(pc.localDescription!);
    } else {
      pc.addEventListener("datachannel", (event) => {
        if (this.pc !== pc) return;
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
    const generation = this.operationGeneration;
    this.recordDiagnostic("signal_receive", signal.kind, { via: transport,
      ...(signal.kind === "description" ? descriptionFields(signal.description) : signal.kind === "candidate" ? candidateFields(signal.candidate) : {}),
    });
    this.signalingTransport = this.signalingHandover.released ? "data" : transport;
    this.signalingHandover.cancel();
    if (!this.pc) await this.preparePeerConnection();
    if (generation !== this.operationGeneration) return;
    const pc = this.pc;
    if (!pc) return;
    const isCurrent = () =>
      this.pc === pc && generation === this.operationGeneration;

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
      await this.rtcOperation("sdp_set_remote", pc, () => pc.setRemoteDescription(receivedDescription), descriptionFields(receivedDescription));
      if (!isCurrent()) return;
      for (const candidate of this.remoteCandidates.update([
        pc.currentRemoteDescription, pc.pendingRemoteDescription, pc.remoteDescription,
      ])) {
        await this.addRemoteCandidate(pc, candidate);
        if (!isCurrent()) return;
      }
      if (signal.description.type === "offer") {
        const answer = await this.rtcOperation("sdp_create_answer", pc, () => pc.createAnswer());
        if (!isCurrent()) return;
        await this.rtcOperation("sdp_set_local", pc, () => pc.setLocalDescription(answer), descriptionFields(answer));
        if (!isCurrent()) return;
        this.sendDescription(pc.localDescription!);
      }
      if (this.policyChangePending) {
        this.policyNegotiated = true;
        await this.updateSelectedRoute(pc, this.selectedPairTransport);
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
      if (pc.remoteDescription) {
        // Refresh current/pending generations after an answer commits them.
        for (const candidate of this.remoteCandidates.update([
          pc.currentRemoteDescription, pc.pendingRemoteDescription, pc.remoteDescription,
        ])) {
          await this.addRemoteCandidate(pc, candidate);
          if (!isCurrent()) return;
        }
      }
      const disposition = this.remoteCandidates.accept(receivedCandidate);
      this.recordDiagnostic("remote_candidate", disposition, candidateFields(receivedCandidate), disposition === "overflow" ? "warn" : "info");
      if (disposition === "ready") {
        await this.addRemoteCandidate(pc, receivedCandidate);
      }
    }
  }

  private async addRemoteCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.rtcOperation("ice_add_candidate", pc, () => pc.addIceCandidate(candidate), candidateFields(candidate));
    } catch (error) {
      if (this.pc !== pc) return;
      if (error instanceof Error && (error.name === "OperationError" || error.name === "TypeError")) {
        this.recordDiagnostic("remote_candidate_rejected", error.name);
        return;
      }
      throw error;
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
    let signals = Promise.resolve();
    channel.addEventListener("open", () => {
      if (this.controlChannel !== channel || this.parked) return;
      this.recordDiagnostic("data_channel_open", "control");
      this.markOnline();
      this.sendData({
        type: "peer_hello",
        device: this.identity.device,
        fileChunkProtocol: 2,
      });
      this.sendConnectionRoute();
    });
    channel.addEventListener("message", (event) => {
      if (this.controlChannel !== channel) return;
      const generation = this.operationGeneration;
      const isCurrent = () =>
        this.controlChannel === channel && generation === this.operationGeneration;
      // Order SDP/ICE without putting chat, acknowledgements or heartbeats
      // behind a potentially slow WebRTC operation.
      this.handleDataMessage(event.data, (signal) => {
        signals = signals.then(async () => {
          if (isCurrent()) {
            await this.handleSignal(signal, "data");
          }
        }).catch((error) => {
          this.recordDiagnostic("data_signal_failed", undefined, { ...rtcErrorFields(error), stale: !isCurrent() }, "warn");
          if (!isCurrent()) return;
          if (this.policyChangePending) this.failPolicyChange();
          else {
            this.relayUpgradePending = false;
            this.scheduleRelayUpgrade();
          }
        });
      });
    });
    channel.addEventListener("close", () => {
      if (this.controlChannel !== channel) return;
      this.recordDiagnostic("data_channel_close", "control");
      if (this.parked && this.reuseProbe) {
        this.completePreviousPathProbe(false);
        return;
      }
      this.disconnect(false);
      this.setStatus("offline", "peerOffline");
    });
  }

  private attachFileChannel(channel: RTCDataChannel): void {
    this.fileChannel = channel;
    channel.addEventListener("open", () => {
      if (this.fileChannel === channel) this.recordDiagnostic("data_channel_open", "file");
      if (this.fileChannel === channel) this.signalingHandover.update();
    });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_BYTES;
    channel.addEventListener("message", (event) => {
      if (this.fileChannel !== channel || this.parked) return;
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
    if (!this.isOnline) return;
    this.iceRestartAttempts = 0;
    this.iceRestartPending = false;
    this.clearConnectionTimers();
    this.clearSignalingTimer();
    this.setStatus("online");
    this.lastPongAt = Date.now();
    if (!this.connectedNotified) {
      this.connectedNotified = true;
      this.sendWs({ type: "connected" });
    }
    this.startHeartbeat();
    this.signalingHandover.update();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatTickAt = Date.now();
    this.heartbeat = window.setInterval(() => {
      const now = Date.now();
      if (
        now - this.lastHeartbeatTickAt > HEARTBEAT_INTERVAL_MS * 2 ||
        now - this.lastPongAt > HEARTBEAT_TIMEOUT_MS
      ) {
        this.beginHeartbeatProbe();
        return;
      }
      this.lastHeartbeatTickAt = now;
      this.sendData({ type: "ping", at: this.nextPingAt() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.heartbeatProbe) window.clearTimeout(this.heartbeatProbe.timer);
    this.heartbeatProbe = undefined;
  }

  private nextPingAt(): number {
    this.lastPingAt = Math.max(Date.now(), this.lastPingAt + 1);
    return this.lastPingAt;
  }

  private beginHeartbeatProbe(): void {
    if (this.heartbeatProbe || !this.networkAvailable || !this.pc || this.parked) return;
    this.stopHeartbeat();
    const pc = this.pc;
    const at = this.nextPingAt();
    const fail = () => {
      if (this.pc !== pc || this.heartbeatProbe?.at !== at) return;
      if (Date.now() - at > HEARTBEAT_PROBE_TIMEOUT_MS * 2) {
        // The page may have slept while this probe itself was outstanding.
        this.stopHeartbeat();
        this.beginHeartbeatProbe();
        return;
      }
      this.parkPreviousPath();
      this.setStatus("offline", "heartbeatTimeout");
    };
    this.heartbeatProbe = {
      at,
      timer: window.setTimeout(fail, HEARTBEAT_PROBE_TIMEOUT_MS),
    };
    this.setStatus("reconnecting", "connectionInterrupted");
    if (!this.sendData({ type: "ping", at })) fail();
  }

  private handleDataMessage(
    raw: unknown,
    enqueueSignal: (signal: RtcSignal) => void,
  ): void {
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
    if (this.parked) {
      const probe = this.reuseProbe;
      if (!probe || !this.networkAvailable) return;
      if (message.type === "ping") {
        this.sendData({ type: "pong", at: message.at });
        // The first ping may have arrived before the other user clicked.
        if (!probe.resent) {
          probe.resent = true;
          this.sendData({ type: "ping", at: probe.at });
        }
      } else if (message.type === "pong" && message.at === probe.at &&
          this.pc?.connectionState === "connected") {
        this.completePreviousPathProbe(true);
      }
      return;
    }
    if (
      this.conversationDeleted &&
      message.type !== "conversation_delete" &&
      message.type !== "ping" &&
      message.type !== "pong"
    ) {
      return;
    }

    if (message.type === "rtc_signal") {
      enqueueSignal(message.signal);
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
        this.setStatus("failed", "peerIdentityMismatch");
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
      this.signalingHandover.pong(message.at);
      if (this.heartbeatProbe) {
        if (message.at !== this.heartbeatProbe.at) return;
        this.stopHeartbeat();
        this.lastPongAt = Date.now();
        this.markOnline();
        return;
      }
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
    this.advanceOutboundQueue();
  }

  private failOutbound(
    transfer: OutboundTransfer,
    reason: RuntimeCode,
  ): void {
    if (this.outbound !== transfer) return;
    // Free the receiver's slot before offering the next queued file.
    if (reason === "fileSendFailed") this.sendData({ type: "file_cancel", messageId: transfer.offer.messageId });
    this.clearOutbound(transfer);
    this.callbacks.onFileRejected(transfer.offer.messageId, reason);
    this.advanceOutboundQueue();
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
    this.outboundQueue = this.outboundQueue.filter(transfer => transfer.offer.messageId !== messageId);
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
    this.advanceOutboundQueue();
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
    if (channel.readyState !== "closed" && channel.readyState !== "closing") channel.close();
    this.failFileTransfers();
  }

  private failFileTransfers(): void {
    const queued = this.outboundQueue.splice(0);
    for (const transfer of queued) this.callbacks.onFileRejected(transfer.offer.messageId, "fileChannelClosed");
    if (this.outbound) this.failOutbound(this.outbound, "fileChannelClosed");
    const inbound = this.inbound;
    this.inbound = undefined;
    if (inbound) {
      this.callbacks.onFileRejected(inbound.offer.messageId, "fileChannelClosed");
      void this.discardInbound(inbound).catch(() => {});
    }
    const pending = [...this.pendingOffers.values()];
    this.pendingOffers.clear();
    for (const offer of pending) this.callbacks.onFileRejected(offer.messageId, "fileChannelClosed");
  }

  private sendData(message: DataMessage): boolean {
    if (this.parked && (!this.reuseProbe || (message.type !== "ping" && message.type !== "pong"))) return false;
    if (this.controlChannel?.readyState !== "open") return false;
    try {
      this.controlChannel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
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
    const queued = this.outboundQueue.splice(0);
    for (const transfer of queued) this.callbacks.onFileCancelled(transfer.offer.messageId);
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

  private sendWs(message: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const typed = message as { type?: string };
      const scoped = this.sessionId && (typed.type === "signal" || typed.type === "connected" || typed.type === "signaling_stable")
        ? { ...typed, sessionId: this.sessionId } : message;
      try {
        this.ws.send(JSON.stringify(scoped));
        return true;
      } catch (error) {
        this.recordDiagnostic("ws_send_failed", typed.type, rtcErrorFields(error), "warn");
      }
    }
    return false;
  }

  private sendRtcSignal(signal: RtcSignal): boolean {
    if (this.parked) return false;
    if (
      this.signalingTransport === "data" &&
      this.sendData({ type: "rtc_signal", signal })
    ) {
      this.recordDiagnostic("signal_send", signal.kind, { via: "data", ...(signal.kind === "description" ? descriptionFields(signal.description) : {}) });
      return true;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.sendWs({ type: "signal", signal })) {
      this.recordDiagnostic("signal_send", signal.kind, { via: "ws", ...(signal.kind === "description" ? descriptionFields(signal.description) : {}) });
      return true;
    }
    this.recordDiagnostic("signal_send_failed", signal.kind, { wsState: this.ws?.readyState, controlState: this.controlChannel?.readyState }, "warn");
    return false;
  }

  private stopTransportWork(reportPendingFailures: boolean): void {
    this.signalingHandover.reset();
    this.stopHeartbeat();
    this.clearConnectionTimers();
    this.stopSelectedPairMonitor();
    this.cancelRelayUpgrade();
    this.clearPolicyChange();
    this.cancelAddressProbe();
    this.clearPendingMessageDeletes(reportPendingFailures);
    this.clearPendingConversationDeletes();
    this.failFileTransfers();
  }

  private resetPeerConnection(reportPendingFailures = true): void {
    this.stopTransportWork(reportPendingFailures);
    const controlChannel = this.controlChannel;
    const fileChannel = this.fileChannel;
    const pc = this.pc;
    this.controlChannel = undefined;
    this.fileChannel = undefined;
    this.pc = undefined;
    controlChannel?.close();
    fileChannel?.close();
    pc?.close();

    this.remoteCandidates = new RemoteIceCandidates();
    this.iceRestartAttempts = 0;
    this.iceRestartPending = false;
    this.connectedNotified = false;
    this.signalingTransport = "ws";
    this.clearConnectionRoute();
  }

  private clearConnectionTimers(): void {
    if (this.connectionTimer) window.clearTimeout(this.connectionTimer);
    if (this.disconnectedTimer) window.clearTimeout(this.disconnectedTimer);
    if (this.connectionDeadlineTimer) window.clearTimeout(this.connectionDeadlineTimer);
    this.connectionTimer = undefined;
    this.disconnectedTimer = undefined;
    this.connectionDeadlineTimer = undefined;
  }

  private armConnectionTimer(pc: RTCPeerConnection): void {
    if (!this.connectionDeadlineTimer) {
      this.connectionDeadlineTimer = window.setTimeout(() => {
        if (this.pc === pc && !this.isOnline) this.failDirectConnection(pc);
      }, CONNECTION_TOTAL_TIMEOUT_MS);
    }
    if (this.connectionTimer) window.clearTimeout(this.connectionTimer);
    this.connectionTimer = window.setTimeout(() => {
      this.connectionTimer = undefined;
      if (this.pc !== pc) return;
      if (this.isOnline) {
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
        ? this.role !== "host" || !this.hasConnectedTransport
        : !shouldScheduleRelayUpgrade(this.relayUpgradeState())
    ) {
      return;
    }
    this.relayUpgradeTimer = window.setTimeout(() => {
      this.relayUpgradeTimer = undefined;
      void this.startInBandIceRestart(force);
    }, delay);
  }

  private cancelRelayUpgrade(): void {
    if (this.relayUpgradeTimer) {
      window.clearTimeout(this.relayUpgradeTimer);
      this.relayUpgradeTimer = undefined;
    }
    this.relayUpgradePending = false;
    this.relayUpgradeAttempts = 0;
  }

  private async startInBandIceRestart(force = false): Promise<void> {
    const pc = this.pc;
    const operationGeneration = this.operationGeneration;
    const configurationGeneration = this.iceConfigurationGeneration;
    const isCurrent = () =>
      this.pc === pc &&
      operationGeneration === this.operationGeneration &&
      configurationGeneration === this.iceConfigurationGeneration;
    if (
      !pc ||
      this.role !== "host" ||
      !this.hasConnectedTransport ||
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
    this.recordDiagnostic("ice_restart", "data", { forced: force });
    if (!force) this.relayUpgradeAttempts += 1;
    this.signalingTransport = "data";
    try {
      pc.setConfiguration(
        rtcConfiguration(this.iceServers, this.relayOnly),
      );
      pc.restartIce();
      const offer = await this.rtcOperation("sdp_create_offer", pc, () => pc.createOffer({ iceRestart: true }), { iceRestart: true });
      if (!isCurrent()) return;
      await this.rtcOperation("sdp_set_local", pc, () => pc.setLocalDescription(offer), descriptionFields(offer));
      if (!isCurrent()) return;
      if (!this.sendDescription(pc.localDescription!)) {
        throw new Error("CONTROL_CHANNEL_NOT_READY");
      }
      this.relayUpgradeTimer = window.setTimeout(() => {
        this.relayUpgradeTimer = undefined;
        this.relayUpgradePending = false;
        this.scheduleRelayUpgrade();
      }, RELAY_UPGRADE_SETTLE_MS);
    } catch (error) {
      if (!isCurrent()) return;
      this.recordDiagnostic("ice_restart_failed", "data", rtcErrorFields(error), "warn");
      this.relayUpgradePending = false;
      if (this.policyChangePending) this.failPolicyChange();
      else if (!force) this.scheduleRelayUpgrade();
    }
  }

  private async attemptIceRestart(pc: RTCPeerConnection): Promise<void> {
    const generation = this.operationGeneration;
    const isCurrent = () =>
      this.pc === pc && generation === this.operationGeneration;
    if (
      this.pc !== pc ||
      this.parked ||
      !this.networkAvailable ||
      pc.connectionState === "closed" ||
      this.iceRestartPending
    ) {
      return;
    }
    if (
      this.ws?.readyState !== WebSocket.OPEN &&
      pc.connectionState === "disconnected"
    ) {
      // No signaling does not make a temporarily disconnected ICE pair dead.
      // Give browser connectivity checks a bounded chance to recover in place.
      if (!this.connectionTimer) {
        this.connectionTimer = window.setTimeout(() => {
          if (this.pc === pc && !this.isOnline) this.failDirectConnection(pc);
        }, CONNECTION_ATTEMPT_TIMEOUT_MS);
      }
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
    this.recordDiagnostic("ice_restart", "ws", { restartAttempt: this.iceRestartAttempts });
    this.iceRestartPending = true;
    this.signalingTransport = "ws";
    this.setStatus("reconnecting", "connectionInterrupted");
    this.armConnectionTimer(pc);

    try {
      if (this.role === "host") {
        pc.restartIce();
        const offer = await this.rtcOperation("sdp_create_offer", pc, () => pc.createOffer({ iceRestart: true }), { iceRestart: true });
        if (!isCurrent()) return;
        await this.rtcOperation("sdp_set_local", pc, () => pc.setLocalDescription(offer), descriptionFields(offer));
        if (!isCurrent()) return;
        this.sendDescription(pc.localDescription!);
      } else {
        this.sendWs({
          type: "signal",
          signal: { kind: "restart_request" },
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.recordDiagnostic("ice_restart_failed", "ws", rtcErrorFields(error), "warn");
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
    this.parkPreviousPath();
    this.setStatus("failed", "directConnectionFailed");
  }

  private get hasReusableTransport(): boolean {
    return Boolean(this.connectedNotified && this.peer && this.pc &&
      this.controlChannel?.readyState === "open" &&
      this.pc.connectionState !== "failed" && this.pc.connectionState !== "closed" &&
      this.fileChannel?.readyState === "open");
  }

  /** Keep the already authenticated ICE/DTLS socket for 30 idle seconds.
   * It is dormant at the application layer until an explicit retry click.
   * Browser ICE consent checks may continue; no new gathering/offer is started.
   */
  private parkPreviousPath(): void {
    if (this.parked) {
      if (this.reuseProbe) this.disconnect(false);
      return;
    }
    if (!this.hasReusableTransport || this.policyChangePending) {
      this.disconnect(false);
      return;
    }
    this.parked = true;
    this.operationGeneration += 1;
    this.requestAbort?.abort();
    this.requestAbort = undefined;
    this.clearSignalingTimer();
    this.stopTransportWork(true);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    this.markAddressesCached();
    this.clearConnectionRoute();
    this.recordDiagnostic("previous_path_parked");
    this.parkedUntil = Date.now() + PREVIOUS_PATH_RETENTION_MS;
    this.parkedTimer = window.setTimeout(() => {
      // Do not abort an explicit probe right at the retention boundary.
      if (this.reuseProbe) return;
      this.disconnect(false);
    }, PREVIOUS_PATH_RETENTION_MS);
  }

  private probePreviousPath(): Promise<boolean> {
    if (!this.parked || !this.hasReusableTransport || Date.now() >= this.parkedUntil) {
      return Promise.resolve(false);
    }
    if (this.parkedTimer) window.clearTimeout(this.parkedTimer);
    this.parkedTimer = undefined;
    this.setStatus("reconnecting", "checkingPreviousPath");
    return new Promise(resolve => {
      const at = this.nextPingAt();
      this.reuseProbe = {
        at, resolve, resent: false,
        timer: window.setTimeout(() => this.completePreviousPathProbe(false), PREVIOUS_PATH_PROBE_MS),
      };
      if (!this.sendData({ type: "ping", at })) this.completePreviousPathProbe(false);
    });
  }

  private completePreviousPathProbe(reused: boolean): void {
    const probe = this.reuseProbe;
    if (!probe) return;
    reused = reused && this.hasReusableTransport && this.networkAvailable;
    this.reuseProbe = undefined;
    window.clearTimeout(probe.timer);
    if (reused) {
      this.parked = false;
      this.recordDiagnostic("previous_path_reused");
      if (this.pc) this.startSelectedPairMonitor(this.pc);
      this.markOnline();
    } else {
      this.recordDiagnostic("previous_path_unavailable");
    }
    probe.resolve(reused);
  }

  private clearPreviousPath(): void {
    this.parkedUntil = 0;
    if (this.parkedTimer) window.clearTimeout(this.parkedTimer);
    this.parkedTimer = undefined;
    this.completePreviousPathProbe(false);
    this.parked = false;
  }

  private clearPolicyChange(): void {
    if (this.policyChangeTimer) window.clearTimeout(this.policyChangeTimer);
    if (this.policyCheckTimer) window.clearTimeout(this.policyCheckTimer);
    this.policyChangeTimer = undefined;
    this.policyCheckTimer = undefined;
    this.policyChangePending = false;
    this.policyNegotiated = false;
  }

  private failPolicyChange(): void {
    this.disconnect(false);
    this.setStatus("failed", "icePolicyFailed");
    this.callbacks.onError("icePolicyFailed");
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
    const probe = this.addressProbe;
    this.addressProbe = undefined;
    probe?.cancel();
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
    const generation = this.operationGeneration;
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
    if (this.pc !== pc || generation !== this.operationGeneration) return;
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
    if (this.policyChangePending) {
      if (
        this.policyNegotiated &&
        (!this.relayOnly || route.localCandidateType === "relay")
      ) {
        this.clearPolicyChange();
        this.markOnline();
      } else {
        if (this.policyCheckTimer) window.clearTimeout(this.policyCheckTimer);
        this.policyCheckTimer = window.setTimeout(() => {
          this.policyCheckTimer = undefined;
          if (this.pc === pc && this.policyChangePending) {
            void this.updateSelectedRoute(pc, transport);
          }
        }, 500);
        return;
      }
    }
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
