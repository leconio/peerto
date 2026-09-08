import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionActions, type ConnectionActionsBindings } from "./use-connection-actions";
import type { KnownPeer } from "../../store";

const peer = { deviceId: "peer", connectionCode: "123456", connectionToken: "token" } as KnownPeer;
function setup() {
  const client = {
    isOnline: false, isConnecting: false,
    refreshPeer: vi.fn(async () => { client.isConnecting = true; return "waiting"; }),
    disconnect: vi.fn(),
  };
  const bindings = {
    client, room: undefined, ipProbing: false, joinCode: "",
    getPeerClient: vi.fn(() => client), getOrCreatePeerClient: vi.fn(() => client),
    activatePeerClient: vi.fn(), inputRef: { current: null },
    setPeerMenuOpen: vi.fn(), setReplyingTo: vi.fn(), setPinnedCursor: vi.fn(),
    setSelectedId: vi.fn(), setMobileConversation: vi.fn(), setNotice: vi.fn(),
    setPeerOffline: vi.fn(), setRoom: vi.fn(), setConnectionDialog: vi.fn(),
    setStatus: vi.fn(), setStatusDetail: vi.fn(), requestHumanVerification: vi.fn(),
  };
  return { client, bindings, actions: useConnectionActions(bindings as unknown as ConnectionActionsBindings) };
}

describe("manual conversation connection actions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", { setTimeout });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("opening or switching an offline conversation never starts a connection", async () => {
    const { actions, client, bindings } = setup();
    actions.selectConversation("peer");
    actions.selectConversation("saved");
    actions.selectConversation("peer");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bindings.getOrCreatePeerClient).not.toHaveBeenCalled();
    expect(client.refreshPeer).not.toHaveBeenCalled();
  });

  it("one click starts one attempt; repeat clicks and navigation leave it intact", async () => {
    const { actions, client } = setup();
    await actions.retryConversation(peer);
    await actions.retryConversation(peer);
    actions.selectConversation("saved");
    expect(client.refreshPeer).toHaveBeenCalledExactlyOnceWith({ deviceId: "peer", code: "123456", token: "token" });
    expect(client.disconnect).not.toHaveBeenCalled();
    actions.cancelConversationConnection("peer");
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("asks for pairing when credentials are missing without allocating a client", async () => {
    const { actions, bindings } = setup();
    await actions.retryConversation({ deviceId: "old-peer" } as KnownPeer);
    expect(bindings.getOrCreatePeerClient).not.toHaveBeenCalled();
    expect(bindings.setNotice).toHaveBeenCalledWith({ key: "error.PAIRING_REQUIRED" });
  });

  it("does not retry on failure or when the browser is offline", async () => {
    const { actions, client } = setup();
    client.refreshPeer.mockRejectedValueOnce(new Error("unreachable"));
    await actions.retryConversation(peer);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.refreshPeer).toHaveBeenCalledOnce();
    vi.stubGlobal("navigator", { onLine: false });
    await actions.retryConversation(peer);
    expect(client.refreshPeer).toHaveBeenCalledOnce();
  });
});
