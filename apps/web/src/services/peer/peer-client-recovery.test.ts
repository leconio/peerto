import type { DeviceIdentity } from "@peerto/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signChallenge } from "../../lib/identity";
import type { LocalIdentity } from "../../lib/identity";
import { PeerClient } from "./peer-client";
import type { PeerClientCallbacks } from "./types";

vi.mock("../../lib/identity", () => ({
  signChallenge: vi.fn(async () => "s".repeat(86)),
}));

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  });
  send = vi.fn();

  constructor(readonly url: string) {
    super();
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(message),
    }));
  }
}

class MockDataChannel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly label: string) { super(); }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(message),
    }));
  }

  messages(): Record<string, unknown>[] {
    return this.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
  }
}

class MockIceTransport extends EventTarget {
  pair = {
    local: { type: "srflx", address: "198.51.100.1", protocol: "udp" },
    remote: { type: "srflx", address: "198.51.100.2", protocol: "udp" },
  };
  getSelectedCandidatePair() { return this.pair; }
}

function description(value: RTCSessionDescriptionInit) {
  return { ...value, toJSON: () => value } as RTCSessionDescription;
}

class MockPeerConnection extends EventTarget {
  static instances: MockPeerConnection[] = [];
  connectionState = "new";
  signalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  transport = new MockIceTransport();
  sctp = { transport: { iceTransport: this.transport } };
  channels: MockDataChannel[] = [];
  setConfiguration = vi.fn();
  restartIce = vi.fn();
  createOffer = vi.fn(async (_options?: RTCOfferOptions) =>
    ({ type: "offer", sdp: "offer-sdp" }) as RTCSessionDescriptionInit,
  );
  createAnswer = vi.fn(async () =>
    ({ type: "answer", sdp: "answer-sdp" }) as RTCSessionDescriptionInit,
  );
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.localDescription = description(value);
    this.signalingState = value.type === "offer" ? "have-local-offer" : "stable";
  });
  setRemoteDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.remoteDescription = description(value);
    this.signalingState = value.type === "offer" ? "have-remote-offer" : "stable";
  });
  addIceCandidate = vi.fn(async () => {});
  getStats = vi.fn(async () => new Map());
  close = vi.fn(() => this.changeState("closed"));

  constructor() {
    super();
    MockPeerConnection.instances.push(this);
  }

  createDataChannel(label: string) {
    const channel = new MockDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  changeState(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMessages() {
  // Drain the HTTP, WS and DataChannel promise queues without advancing timers.
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

const localDevice: DeviceIdentity = {
  deviceId: "local-device-id-longer-than-twenty-characters",
  name: "Local",
  publicKey: {
    crv: "P-256",
    kty: "EC",
    x: "x",
    y: "y",
  },
};

const peerDevice: DeviceIdentity = {
  deviceId: "peer-device-id-longer-than-twenty-characters",
  name: "Peer",
  publicKey: {
    crv: "P-256",
    kty: "EC",
    x: "x",
    y: "y",
  },
};

function callbacks(): PeerClientCallbacks {
  return {
    onStatus: vi.fn(),
    onRoom: vi.fn(),
    onPublicAddresses: vi.fn(),
    onAddressProbeState: vi.fn(),
    onConnectionRoute: vi.fn(),
    onJoinRequest: vi.fn(),
    onPeer: vi.fn(),
    onText: vi.fn(),
    onAck: vi.fn(),
    onMessagePin: vi.fn(),
    onMessageDelete: vi.fn(() => true),
    onMessageDeleteResult: vi.fn(),
    onConversationDelete: vi.fn(async () => true),
    onFileOffer: vi.fn(),
    onFileProgress: vi.fn(),
    onFileSent: vi.fn(),
    onFileReceived: vi.fn(),
    onFileRejected: vi.fn(),
    onFileCancelled: vi.fn(),
    onError: vi.fn(),
  };
}

const clients: PeerClient[] = [];
const target = { deviceId: peerDevice.deviceId, code: "123456", token: "a".repeat(32) };

function createClient() {
  const events = callbacks();
  const client = new PeerClient(
    { device: localDevice, keyPair: {} as CryptoKeyPair },
    { iceServers: [], maxFileBytes: 1, roomTtlSeconds: 300 },
    events,
  );
  clients.push(client);
  return { client, events };
}

async function createSession(role: "host" | "guest" = "host", online = true) {
  const { client, events } = createClient();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    code: target.code, expiresAt: Date.now() + 300_000, role,
  })));
  await client.refreshPeer(target);
  const ws = MockWebSocket.instances.at(-1)!;
  ws.open();
  ws.receive({
    type: "peer_accepted", peer: peerDevice,
    rendezvous: { code: target.code, token: target.token, role },
  });
  await flushMessages();
  const pc = MockPeerConnection.instances.at(-1)!;
  if (role === "guest") {
    for (const label of ["control", "file"]) {
      const channel = pc.createDataChannel(label);
      pc.dispatchEvent(Object.assign(new Event("datachannel"), { channel }));
    }
  } else {
    ws.receive({ type: "signal", signal: {
      kind: "description", description: { type: "answer", sdp: "initial-answer" },
    } });
    await flushMessages();
  }
  const channel = pc.channels.find((item) => item.label === "control")!;
  if (online) {
    pc.changeState("connected");
    channel.open();
    pc.channels.find(item => item.label === "file")!.open();
  }
  return { client, events, pc, channel, ws };
}

describe("known-peer recovery", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.mocked(signChallenge).mockReset().mockResolvedValue("s".repeat(86));
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", {
      location: new URL("https://peerto.test/"),
      setTimeout, clearTimeout, setInterval, clearInterval,
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("RTCPeerConnection", MockPeerConnection);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces address probes and closes the probe immediately on cancellation", async () => {
    const { client } = createClient();
    const first = client.probePublicAddresses();
    const second = client.probePublicAddresses();
    expect(MockPeerConnection.instances).toHaveLength(1);
    const probe = MockPeerConnection.instances[0]!;
    client.disconnect(false);
    expect(probe.close).toHaveBeenCalledOnce();
    await Promise.all([first, second]);
    expect(probe.setLocalDescription).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips extra address gathering while the session is connecting or parked", async () => {
    const { client, pc } = await createSession();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    await client.probePublicAddresses();
    expect(MockPeerConnection.instances).toEqual([pc]);
    client.disconnect(false);
    await client.refreshPeer(target);
    await client.probePublicAddresses();
    expect(MockPeerConnection.instances).toEqual([pc]);
  });

  it.each(["cancel", "timeout"])("bounds the address stats fallback: %s", async reason => {
    const { client } = createClient();
    const pending = client.probePublicAddresses();
    const probe = MockPeerConnection.instances[0]!;
    probe.getStats.mockImplementationOnce(() => new Promise(() => {}));
    probe.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
    await flushMessages();
    expect(probe.getStats).toHaveBeenCalledOnce();
    if (reason === "cancel") client.disconnect(false);
    else await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(probe.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the previous path dormant until a matching explicit retry pong", async () => {
    const { client, pc, channel, events } = await createSession();
    const fetchMock = vi.mocked(fetch);
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    client.checkConnectionAfterResume();
    pc.changeState("connected");
    channel.send.mockClear();
    channel.receive({ type: "ping", at: 123 });
    channel.receive({ type: "chat", id: "dropped", text: "offline", createdAt: Date.now() });
    expect(client.sendText("blocked", "offline", Date.now())).toBe(false);
    expect(events.onText).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(client.isOnline).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();

    const pending = client.refreshPeer(target);
    const ping = channel.messages().at(-1)!;
    expect(ping.type).toBe("ping");
    client.setNetworkAvailable(true, false);
    expect(client.isConnecting).toBe(true);
    expect(await client.refreshPeer(target)).toBe("cancelled");
    channel.receive({ type: "pong", at: Number(ping.at) - 1 });
    expect(client.isOnline).toBe(false);
    channel.receive({ type: "pong", at: ping.at });
    expect(await pending).toBe("reused");
    expect(client.isOnline).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pc.createOffer).toHaveBeenCalledOnce();
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(MockPeerConnection.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it.each([0, 500, 1_200])("reuses both previous paths with retry clicks %i ms apart", async delay => {
    const a = await createSession("host");
    const b = await createSession("guest");
    for (const item of [a, b]) {
      item.client.setNetworkAvailable(false, false);
      item.client.setNetworkAvailable(true, false);
    }
    a.channel.send.mockImplementation(raw => { void Promise.resolve().then(() => b.channel.receive(JSON.parse(raw))); });
    b.channel.send.mockImplementation(raw => { void Promise.resolve().then(() => a.channel.receive(JSON.parse(raw))); });
    const first = a.client.refreshPeer(target);
    await vi.advanceTimersByTimeAsync(delay);
    const second = b.client.refreshPeer(target);
    expect(await Promise.all([first, second])).toEqual(["reused", "reused"]);
    expect(a.client.isOnline && b.client.isOnline).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockPeerConnection.instances).toHaveLength(2);
  });

  it.each(["timeout", "channel_closed", "file_closed"])("falls back exactly once when previous path fails: %s", async reason => {
    const { client, pc, channel } = await createSession();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    const pending = client.refreshPeer(target);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1_500);
    else if (reason === "channel_closed") channel.close();
    else {
      pc.channels.find(item => item.label === "file")!.close();
      channel.receive({ type: "pong", at: channel.messages().at(-1)!.at });
    }
    expect(await pending).toBe("waiting");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each(["cancel", "offline"])("does not fall back after cancelling a previous-path probe: %s", async reason => {
    const { client, channel } = await createSession();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    const pending = client.refreshPeer(target);
    const ping = channel.messages().at(-1)!;
    if (reason === "cancel") client.disconnect(false);
    else client.setNetworkAvailable(false, false);
    expect(await pending).toBe("cancelled");
    channel.receive({ type: "pong", at: ping.at });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.isOnline).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("expires a parked transport without reconnecting and skips reuse after expiry", async () => {
    const { client, pc, events } = await createSession();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(client.isOnline).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(await client.refreshPeer(target)).toBe("waiting");
    expect(events.onStatus).not.toHaveBeenCalledWith("reconnecting", "checkingPreviousPath");
  });

  it.each(["file_closed", "sleep_expired"])("does not reuse an invalid previous transport: %s", async reason => {
    const { client, pc, events } = await createSession();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    if (reason === "file_closed") pc.channels.find(channel => channel.label === "file")!.close();
    else vi.setSystemTime(Date.now() + 60_000); // Wake before delayed timers run.
    expect(await client.refreshPeer(target)).toBe("waiting");
    expect(events.onStatus).not.toHaveBeenCalledWith("reconnecting", "checkingPreviousPath");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each(["host", "guest"] as const)("uses authenticated %s role instead of the initial WS hint", async role => {
    const { client } = createClient();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      code: target.code, expiresAt: Date.now() + 300_000, role: role === "host" ? "guest" : "host",
    })));
    await client.refreshPeer(target);
    const ws = MockWebSocket.instances.at(-1)!;
    ws.open();
    ws.receive({ type: "peer_accepted", sessionId: "new-session", peer: peerDevice,
      rendezvous: { code: target.code, token: target.token, role } });
    await flushMessages();
    const pc = MockPeerConnection.instances.at(-1)!;
    expect(pc.createOffer).toHaveBeenCalledTimes(role === "host" ? 1 : 0);
    ws.receive({ type: "signal", sessionId: "old-session", signal: {
      kind: "description", description: { type: "offer", sdp: "stale" },
    } });
    await flushMessages();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    ws.receive({ type: "room_ready", code: target.code, expiresAt: Date.now() + 300_000 });
    await flushMessages();
    expect(pc.close).toHaveBeenCalledOnce();
    ws.receive({ type: "peer_accepted", sessionId: "newer-session", peer: peerDevice,
      rendezvous: { code: target.code, token: target.token, role: "host" } });
    await flushMessages();
    const replacement = MockPeerConnection.instances.at(-1)!;
    expect(replacement).not.toBe(pc);
    expect(replacement.createOffer).toHaveBeenCalledOnce();
    const outgoing = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(outgoing.at(-1)).toMatchObject({ type: "signal", sessionId: "newer-session" });
  });

  it("replaces a stale open socket with a fresh rendezvous", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: "123456",
          expiresAt: Date.now() + 300_000,
          role: "host",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PeerClient(
      {
        device: localDevice,
        keyPair: {} as CryptoKeyPair,
      } satisfies LocalIdentity,
      { iceServers: [], maxFileBytes: 1, roomTtlSeconds: 300 },
      callbacks(),
    );
    clients.push(client);
    const staleSocket = new MockWebSocket("wss://stale.test/ws");
    staleSocket.readyState = MockWebSocket.OPEN;
    const internals = client as unknown as {
      peer: DeviceIdentity;
      ws: WebSocket;
    };
    internals.peer = peerDevice;
    internals.ws = staleSocket as unknown as WebSocket;
    MockWebSocket.instances = [];

    await expect(
      client.refreshPeer({
        deviceId: peerDevice.deviceId,
        code: "123456",
        token: "a".repeat(32),
      }),
    ).resolves.toBe("waiting");

    expect(staleSocket.close).toHaveBeenCalledWith(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toContain(
      "wss://peerto.test/ws?role=host&code=123456",
    );
  });

  it.each(["new", "connecting", "disconnected", "failed", "closed"])(
    "does not treat an open channel on a %s transport as online", async (state) => {
      const { client, pc } = await createSession();
      expect(client.isOnline).toBe(true);
      pc.connectionState = state;
      expect(client.isOnline).toBe(false);
    },
  );

  it("cancels room creation even if fetch ignores the abort signal", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { client, events } = createClient();
    const pending = client.startHost();
    await flushMessages();
    client.disconnect(false);
    await pending;
    response.resolve(Response.json({ code: "123456" }));
    await flushMessages();
    expect(events.onRoom).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal?.aborted).toBe(true);
  });

  it("discards a cancelled response body without replacing the newer session", async () => {
    const body = deferred<unknown>();
    const response = { ok: true, json: vi.fn(() => body.promise) };
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const { client } = createClient();
    const oldRequest = client.startHost();
    await flushMessages();
    client.join("654321");
    await expect(oldRequest).resolves.toBeUndefined();
    body.resolve({ code: "123456", expiresAt: Date.now() + 300_000, role: "host" });
    await flushMessages();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toContain("code=654321");
  });

  it("does not authenticate or fail a replacement socket from stale events", async () => {
    const signature = deferred<string>();
    vi.mocked(signChallenge).mockReturnValueOnce(signature.promise);
    const { client, events } = createClient();
    client.join("123456");
    const oldSocket = MockWebSocket.instances[0]!;
    oldSocket.open();
    oldSocket.receive({ type: "challenge", challenge: "c".repeat(32) });
    await flushMessages();
    expect(signChallenge).toHaveBeenCalledOnce();
    client.join("654321");
    const replacement = MockWebSocket.instances[1]!;
    replacement.open();
    signature.resolve("s".repeat(86));
    oldSocket.dispatchEvent(new Event("error"));
    oldSocket.receive({ type: "room_closed", reason: "expired" });
    await flushMessages();
    expect(replacement.send).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(events.onStatus).not.toHaveBeenCalledWith("failed", expect.anything());
  });

  it("discards an SDP continuation after cancellation", async () => {
    const { client, pc, channel } = await createSession("guest");
    const remoteDescription = deferred<void>();
    pc.setRemoteDescription.mockImplementationOnce(() => remoteDescription.promise);
    channel.receive({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "offer", sdp: "late-offer" },
    } });
    await flushMessages();
    client.join("654321");
    remoteDescription.resolve();
    await flushMessages();
    expect(pc.createAnswer).not.toHaveBeenCalled();
    expect(MockWebSocket.instances.at(-1)?.send).not.toHaveBeenCalled();
  });

  it("forces a host ICE restart and verifies the local relay candidate", async () => {
    const { client, pc, channel } = await createSession();
    client.setIceServers([{ urls: "turn:relay.test", username: "u", credential: "p" }], true);
    await flushMessages();
    expect(pc.restartIce).toHaveBeenCalledOnce();
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    expect(client.isOnline).toBe(false);
    expect(client.isCheckingConnection).toBe(true);
    pc.transport.pair.remote.type = "relay";
    channel.receive({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "answer", sdp: "relay-answer" },
    } });
    await flushMessages();
    expect(client.isOnline).toBe(false);
    pc.transport.pair.local.type = "relay";
    pc.transport.dispatchEvent(new Event("selectedcandidatepairchange"));
    expect(client.isOnline).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("lets a guest request the host restart for a policy change", async () => {
    const { client, pc, channel } = await createSession("guest");
    client.setIceServers([{ urls: "turn:relay.test" }], true);
    expect(channel.messages()).toContainEqual({
      type: "rtc_signal", signal: { kind: "restart_request" },
    });
    pc.transport.pair.local.type = "relay";
    channel.receive({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "offer", sdp: "restart-offer" },
    } });
    await flushMessages();
    expect(pc.createAnswer).toHaveBeenCalledOnce();
    expect(client.isOnline).toBe(true);
  });

  it("does not strand an in-flight policy offer when only ICE server details change", async () => {
    const { client, pc, channel } = await createSession();
    const offer = deferred<RTCSessionDescriptionInit>();
    pc.createOffer.mockReturnValueOnce(offer.promise);
    client.setIceServers([{ urls: "turn:first.test" }], true);
    client.setIceServers([{ urls: "turn:second.test" }], true);
    offer.resolve({ type: "offer", sdp: "policy-offer" });
    await flushMessages();
    expect(channel.messages()).toContainEqual({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "offer", sdp: "policy-offer" },
    } });
    pc.transport.pair.local.type = "relay";
    channel.receive({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "answer", sdp: "policy-answer" },
    } });
    await flushMessages();
    expect(client.isOnline).toBe(true);
  });

  it("fails a policy change explicitly when no valid local relay is selected", async () => {
    const { client, pc, events } = await createSession();
    client.setIceServers([{ urls: "turn:relay.test" }], true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(events.onStatus).toHaveBeenLastCalledWith("failed", "icePolicyFailed");
    expect(events.onError).toHaveBeenCalledWith("icePolicyFailed");
  });

  it("does not keep a direct connection after the browser rejects relay configuration", async () => {
    const { client, pc, events } = await createSession();
    pc.setConfiguration.mockImplementationOnce(() => { throw new Error("invalid config"); });
    client.setIceServers([{ urls: "turn:relay.test" }], true);
    expect(client.isOnline).toBe(false);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledWith("icePolicyFailed");
  });

  it("does not restore an unverified policy change after a network outage", async () => {
    const { client, pc, events } = await createSession();
    client.setIceServers([{ urls: "turn:relay.test" }], true);
    await flushMessages();
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(client.isOnline).toBe(false);
    expect(events.onStatus).toHaveBeenLastCalledWith("offline", "networkRestored");
  });

  it("answers heartbeats while an in-band SDP operation is stalled", async () => {
    const { pc, channel } = await createSession("guest");
    const pending = deferred<void>();
    pc.setRemoteDescription.mockImplementationOnce(() => pending.promise);
    channel.receive({ type: "rtc_signal", signal: {
      kind: "description", description: { type: "offer", sdp: "slow-offer" },
    } });
    await flushMessages();
    channel.receive({ type: "ping", at: 123 });
    await flushMessages();
    expect(channel.messages()).toContainEqual({ type: "pong", at: 123 });
    pending.resolve();
    await flushMessages();
  });

  it("probes after a suspended timer and accepts only its matching pong", async () => {
    const { client, pc, channel } = await createSession();
    vi.setSystemTime(Date.now() + 45_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const ping = channel.messages().filter((message) => message.type === "ping").at(-1)!;
    expect(pc.close).not.toHaveBeenCalled();
    expect(client.isCheckingConnection).toBe(true);
    channel.receive({ type: "pong", at: Number(ping.at) - 1 });
    await flushMessages();
    expect(client.isOnline).toBe(false);
    channel.receive({ type: "pong", at: ping.at });
    await flushMessages();
    expect(client.isOnline).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("expires a resume probe but never closes a subsequent session", async () => {
    const { client, pc, events } = await createSession();
    client.checkConnectionAfterResume();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pc.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pc.close).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith("offline", "heartbeatTimeout");

    const newer = await createSession();
    newer.client.checkConnectionAfterResume();
    newer.client.join("654321");
    const replacement = MockWebSocket.instances.at(-1)!;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("reprobes instead of failing a probe timer that was itself suspended", async () => {
    const { client, pc, channel } = await createSession();
    client.checkConnectionAfterResume();
    const firstPing = channel.messages().at(-1)!;
    vi.setSystemTime(Date.now() + 45_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const secondPing = channel.messages().at(-1)!;
    expect(secondPing.type).toBe("ping");
    expect(secondPing.at).not.toBe(firstPing.at);
    expect(pc.close).not.toHaveBeenCalled();
    channel.receive({ type: "pong", at: secondPing.at });
    await flushMessages();
    expect(client.isOnline).toBe(true);
  });

  it("does not interrupt setup when the page becomes visible", async () => {
    const { client, pc, events } = await createSession("host", false);
    client.checkConnectionAfterResume();
    expect(events.onStatus).not.toHaveBeenCalledWith("offline", expect.anything());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.restartIce).toHaveBeenCalledOnce();
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("does not let delayed PC events replace network-offline status", async () => {
    const { client, pc, events } = await createSession();
    client.setNetworkAvailable(false, false);
    pc.changeState("failed");
    expect(events.onStatus).toHaveBeenLastCalledWith("network_offline", "networkOffline");
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(client.isOnline).toBe(false);
  });

  it("discards queued in-band signals across an offline generation", async () => {
    const { client, pc, channel } = await createSession("guest");
    const pending = deferred<void>();
    pc.setRemoteDescription.mockImplementationOnce(() => pending.promise);
    const signal = { type: "rtc_signal", signal: {
      kind: "description", description: { type: "offer", sdp: "old-offer" },
    } };
    channel.receive(signal);
    channel.receive(signal);
    await flushMessages();
    client.setNetworkAvailable(false, false);
    pending.resolve();
    await flushMessages();
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(pc.createAnswer).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("bounds a room request whose %s stall", async (phase) => {
    const stalled = new Promise(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => phase === "headers"
      ? stalled : { ok: true, json: () => stalled }));
    const { client } = createClient();
    const pending = client.startHost();
    const failure = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("bounds the websocket handshake separately from an authenticated host wait", async () => {
    const { client, events } = createClient();
    client.join("123456");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.onStatus).toHaveBeenLastCalledWith("failed", "signalingTimeout");
    client.join("654321");
    const socket = MockWebSocket.instances.at(-1)!;
    socket.receive({ type: "room_ready", code: "654321", expiresAt: Date.now() + 60_000 });
    await flushMessages();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(events.onStatus).toHaveBeenLastCalledWith("failed", "codeExpired");
  });

  it("gives ICE setup its complete initial and two restart budgets", async () => {
    const { pc, channel, events } = await createSession("host", false);
    channel.open();
    expect(events.onStatus).not.toHaveBeenCalledWith("online");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(pc.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.restartIce).toHaveBeenCalledTimes(2);
    expect(pc.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.onStatus).toHaveBeenLastCalledWith("failed", "directConnectionFailed");
  });

  it("does not cancel the setup budget until the control channel is also open", async () => {
    const { client, pc, channel } = await createSession("host", false);
    pc.changeState("connected");
    expect(client.isOnline).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.restartIce).toHaveBeenCalledOnce();
    channel.open();
    expect(client.isOnline).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pc.restartIce).toHaveBeenCalledOnce();
  });

  it.each(["error", "close"])("preserves a healthy P2P link on WS %s", async (event) => {
    const { pc, client, ws } = await createSession();
    ws.dispatchEvent(new Event(event));
    expect(pc.close).not.toHaveBeenCalled();
    expect(client.isOnline).toBe(true);
  });

  it.each(["host_offline", "expired"])("probes healthy P2P after room_closed %s", async (reason) => {
    const { client, pc, ws, channel } = await createSession();
    ws.receive({ type: "room_closed", reason });
    await flushMessages();
    expect(pc.close).not.toHaveBeenCalled();
    expect(client.isCheckingConnection).toBe(true);
    const ping = channel.messages().filter(message => message.type === "ping").at(-1)!;
    channel.receive({ type: "pong", at: ping.at });
    await flushMessages();
    expect(client.isOnline).toBe(true);
  });

  it.each(["replaced", "ip_changed", "invalid_code"])("does not ignore room security failure %s", async reason => {
    const { pc, ws } = await createSession();
    ws.receive({ type: "room_closed", reason });
    await flushMessages();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("isolates a rejected candidate without hiding SDP failures", async () => {
    const { client, pc, ws } = await createSession();
    pc.addIceCandidate.mockRejectedValueOnce(new DOMException("candidate rejected", "OperationError"));
    ws.receive({ type: "signal", signal: { kind: "candidate", candidate: {
      candidate: "candidate:1 1 udp 2122260223 198.51.100.1 50000 typ host", sdpMid: "0",
    } } });
    await flushMessages();
    expect(pc.addIceCandidate).toHaveBeenCalledOnce();
    expect(client.isOnline).toBe(true);
    expect(client.getConnectionDiagnostics()).toContainEqual(expect.objectContaining({ event: "remote_candidate_rejected", detail: "OperationError" }));
    pc.setRemoteDescription.mockRejectedValueOnce(new DOMException("bad SDP", "OperationError"));
    ws.receive({ type: "signal", signal: { kind: "description", description: { type: "answer", sdp: "invalid" } } });
    await flushMessages();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("finishes pending file state exactly once on heartbeat failure", async () => {
    const { client, pc, events } = await createSession();
    pc.channels.find(item => item.label === "file")!.open();
    const offer = client.offerFile(new File(["x"], "one.txt"));
    client.checkConnectionAfterResume();
    await vi.advanceTimersByTimeAsync(5_000);
    client.disconnect(false);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(events.onFileRejected).toHaveBeenCalledExactlyOnceWith(offer.messageId, "fileChannelClosed");
  });

  it("logs ICE and SDP failures with operation, state and no raw sensitive payload", async () => {
    const { client, pc, ws } = await createSession();
    pc.setRemoteDescription.mockRejectedValueOnce(new DOMException("private SDP 198.51.100.7 ice-pwd=secret", "OperationError"));
    ws.receive({ type: "signal", signal: { kind: "description", description: { type: "answer", sdp: "a=ice-pwd:secret" } } });
    await flushMessages();
    expect(client.getConnectionDiagnostics()).toContainEqual(expect.objectContaining({ event: "sdp_set_remote_failed", error: "OperationError", role: "host", stale: false }));
    const logged = JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.warn).mock.calls]);
    expect(logged).toContain("sdp_set_remote_failed");
    expect(logged).not.toMatch(/secret|198\.51|private SDP|peer-device|local-device/);
    expect(logged).not.toContain(target.token);
  });

  it("sends multiple queued files serially, waiting for each completion", async () => {
    const { client, channel, events } = await createSession();
    const offers = ["one.txt", "two.txt", "three.txt"].map(name => client.offerFile(new File([], name)));
    expect(channel.messages().filter(message => message.type === "file_offer")).toHaveLength(1);
    for (const offer of offers) {
      channel.receive({ type: "file_accept", transferId: offer.transferId });
      await flushMessages();
      expect(channel.messages()).toContainEqual({ type: "file_end", transferId: offer.transferId });
      channel.receive({ type: "file_complete", transferId: offer.transferId });
      expect(events.onFileSent).toHaveBeenCalledWith(offer.messageId, true);
    }
    expect(channel.messages().filter(message => message.type === "file_offer").map(message => message.name)).toEqual(["one.txt", "two.txt", "three.txt"]);
    expect(events.onFileSent).toHaveBeenCalledTimes(3);
  });

  it("cancels queued files and advances past rejected active files", async () => {
    const { client, channel, events } = await createSession();
    const first = client.offerFile(new File([], "first"));
    const removed = client.offerFile(new File([], "remove"));
    const last = client.offerFile(new File([], "last"));
    expect(client.cancelFile(removed.messageId)).toBe(true);
    channel.receive({ type: "file_reject", transferId: first.transferId });
    expect(channel.messages().filter(message => message.type === "file_offer").map(message => message.messageId)).toEqual([first.messageId, last.messageId]);
    expect(events.onFileCancelled).toHaveBeenCalledExactlyOnceWith(removed.messageId);
  });

  it("bounds the queue and clears every queued file exactly once on disconnect", async () => {
    const { client, channel, events } = await createSession();
    const offers = Array.from({ length: 32 }, (_, index) => client.offerFile(new File([], `${index}.txt`)));
    expect(() => client.offerFile(new File([], "overflow.txt"))).toThrow("FILE_QUEUE_FULL");
    client.disconnect(false);
    client.disconnect(false);
    expect(events.onFileRejected).toHaveBeenCalledTimes(32);
    for (const offer of offers) expect(events.onFileRejected).toHaveBeenCalledWith(offer.messageId, "fileChannelClosed");
    expect(channel.messages().filter(message => message.type === "file_offer")).toHaveLength(1);
  });

  it("does not reset the setup budget until the data channel opens", async () => {
    const { pc, events } = await createSession("host", false);
    for (let index = 0; index < 4; index += 1) {
      pc.changeState("disconnected");
      await vi.advanceTimersByTimeAsync(1_000);
      pc.changeState("connected");
      await vi.advanceTimersByTimeAsync(14_000);
    }
    expect(events.onStatus).toHaveBeenCalledWith("failed", "directConnectionFailed");
    expect(pc.restartIce.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("never reconnects a terminal offline session on network return or visibility", async () => {
    const { client, pc, events } = await createSession();
    const fetchMock = vi.mocked(fetch);
    client.setNetworkAvailable(false, false);
    client.setNetworkAvailable(true, false);
    client.checkConnectionAfterResume();
    await vi.advanceTimersByTimeAsync(300_000);
    pc.changeState("connected");
    expect(client.isOnline).toBe(false);
    expect(client.isConnecting).toBe(false);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(events.onStatus).toHaveBeenLastCalledWith("offline", "networkRestored");
  });

  it("allows transient ICE recovery after signaling release without recreating the peer", async () => {
    const { client, pc, ws } = await createSession();
    ws.receive({ type: "room_consumed" });
    await flushMessages();
    ws.close();
    pc.changeState("disconnected");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pc.close).not.toHaveBeenCalled();
    pc.changeState("connected");
    expect(client.isOnline).toBe(true);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(MockPeerConnection.instances).toHaveLength(1);
  });

  it("hands signaling over to P2P only after gathering and a fresh probe", async () => {
    const { client, pc, ws, channel } = await createSession();
    Object.assign(pc, { iceGatheringState: "gathering" });
    ws.receive({ type: "room_consumed" }); await flushMessages();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw)).some(m => m.type === "signaling_stable")).toBe(false);
    Object.assign(pc, { iceGatheringState: "complete" });
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    await vi.advanceTimersByTimeAsync(3_000);
    const ping = channel.messages().at(-1)!;
    expect(ping.type).toBe("ping"); channel.receive({ type: "pong", at: ping.at });
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw)).at(-1)).toMatchObject({ type: "signaling_stable" });
    ws.close();
    expect(client.isOnline).toBe(true);
    expect(client.sendText("message", "after handover", Date.now())).toBe(true);
    expect(channel.messages().at(-1)).toMatchObject({ type: "chat", text: "after handover" });
  });

  it("terminates a prolonged disconnect without scheduling another rendezvous", async () => {
    const { client, pc, ws, events } = await createSession();
    ws.close();
    pc.changeState("disconnected");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pc.close).not.toHaveBeenCalled();
    expect(client.isConnecting).toBe(false);
    expect(events.onStatus).toHaveBeenLastCalledWith("failed", "directConnectionFailed");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
