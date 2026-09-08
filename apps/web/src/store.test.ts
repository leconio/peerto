import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("removeConversation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("./lib/database");
    vi.stubGlobal("navigator", {
      language: "zh-CN",
      platform: "Test",
    });
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("removes only the selected peer and its messages", async () => {
    const { SAVED_CONVERSATION_ID, useAppStore } = await import("./store");
    const peer = {
      deviceId: "device-identity-with-more-than-twenty-characters",
      name: "测试设备",
      publicKey: {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: "x",
        y: "y",
      },
    };
    const state = useAppStore.getState();
    state.upsertPeer(peer);
    state.addMessage({
      id: "peer-message",
      conversationId: peer.deviceId,
      senderId: peer.deviceId,
      kind: "text",
      text: "peer",
      createdAt: 1,
      status: "delivered",
    });
    state.addMessage({
      id: "saved-message",
      conversationId: SAVED_CONVERSATION_ID,
      senderId: "self",
      kind: "text",
      text: "saved",
      createdAt: 2,
      status: "local",
    });

    await useAppStore.getState().removeConversation(peer.deviceId);

    expect(useAppStore.getState().peers).toHaveLength(0);
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(
      ["saved-message"],
    );
  });

  it("keeps conversation metadata when local resource cleanup fails", async () => {
    vi.doMock("./lib/database", () => ({
      deleteFileHandle: vi
        .fn()
        .mockRejectedValue(new Error("IDB_DELETE_FAILED")),
    }));
    const { useAppStore } = await import("./store");
    const peer = {
      deviceId: "device-with-resource-cleanup-failure",
      name: "测试设备",
      publicKey: {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: "x",
        y: "y",
      },
    };
    useAppStore.getState().upsertPeer(peer);
    useAppStore.getState().addMessage({
      id: crypto.randomUUID(),
      conversationId: peer.deviceId,
      senderId: peer.deviceId,
      kind: "file",
      file: {
        name: "report.pdf",
        size: 10,
        mime: "application/pdf",
        handleKey: "stored-handle",
      },
      createdAt: 1,
      status: "delivered",
    });

    await expect(
      useAppStore.getState().removeConversation(peer.deviceId),
    ).resolves.toBe(false);
    expect(useAppStore.getState().peers).toHaveLength(1);
    expect(useAppStore.getState().messages).toHaveLength(1);
  });

  it("stores reply metadata and can pin then unpin a message", async () => {
    const { useAppStore } = await import("./store");
    const messageId = crypto.randomUUID();
    useAppStore.getState().addMessage({
      id: messageId,
      conversationId: "saved",
      senderId: "self",
      kind: "text",
      text: "reply",
      replyTo: {
        messageId: crypto.randomUUID(),
        senderId: "self",
        kind: "text",
        preview: "original",
      },
      createdAt: 3,
      status: "local",
    });

    useAppStore.getState().setMessagePinned(messageId, 10);
    expect(useAppStore.getState().messages[0]).toMatchObject({
      pinnedAt: 10,
      replyTo: { preview: "original" },
    });

    useAppStore.getState().setMessagePinned(messageId, null);
    expect(useAppStore.getState().messages[0]).not.toHaveProperty(
      "pinnedAt",
    );
  });

  it("removes legacy custom IP values while restoring peers", async () => {
    const { withoutLegacyCustomIps } = await import("./store");
    const restored = withoutLegacyCustomIps([
      {
        deviceId: "peer-with-custom-network-address",
        name: "LAN phone",
        publicKey: {
          crv: "P-256",
          kty: "EC",
          x: "x",
          y: "y",
        },
        lastConnectedAt: 1,
        customIp: "192.168.8.20",
      },
    ]);
    expect(restored[0]?.name).toBe("LAN phone");
    expect(restored[0]).not.toHaveProperty("customIp");
  });

  it("removes only the selected message", async () => {
    const { useAppStore } = await import("./store");
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const testMessages: Array<[string, string]> = [
      [firstId, "first"],
      [secondId, "second"],
    ];
    for (const [id, text] of testMessages) {
      useAppStore.getState().addMessage({
        id,
        conversationId: "saved",
        senderId: "self",
        kind: "text",
        text,
        createdAt: Date.now(),
        status: "local",
      });
    }

    useAppStore.getState().removeMessage(firstId);

    expect(
      useAppStore.getState().messages.map((message) => message.id),
    ).toEqual([secondId]);
  });
});
