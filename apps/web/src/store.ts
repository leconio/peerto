import type {
  DeviceIdentity,
  ReplyReference,
  RendezvousInfo,
} from "@peerto/protocol";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deleteFileHandle } from "./lib/database";
import { initialDeviceName } from "./lib/device-name";
import { saveFirstDeviceName } from "./lib/first-use";
import {
  deleteCachedResourceFile,
  deleteCachedResourceFileStrict,
} from "./services/file-transfer";

export type MessageStatus =
  | "local"
  | "sending"
  | "sent"
  | "delivered"
  | "failed";

export interface StoredFile {
  name: string;
  size: number;
  mime: string;
  handleKey?: string;
  resourceKey?: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string;
  kind: "text" | "file";
  text?: string;
  file?: StoredFile;
  replyTo?: ReplyReference;
  pinnedAt?: number;
  createdAt: number;
  status: MessageStatus;
}

export interface KnownPeer extends DeviceIdentity {
  lastConnectedAt: number;
  connectionCode?: string;
  connectionToken?: string;
}

export interface AppState {
  deviceName: string;
  theme: "light" | "dark" | "system";
  peers: KnownPeer[];
  messages: StoredMessage[];
  setDeviceName: (name: string) => void;
  setTheme: (theme: AppState["theme"]) => void;
  upsertPeer: (
    peer: DeviceIdentity,
    rendezvous?: RendezvousInfo,
  ) => void;
  removeConversation: (deviceId: string) => Promise<boolean>;
  addMessage: (message: StoredMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (
    id: string,
    patch: Partial<Pick<StoredMessage, "status" | "file">>,
  ) => void;
  setMessagePinned: (id: string, pinnedAt: number | null) => void;
}

export function withoutLegacyCustomIps(
  peers: Array<KnownPeer & { customIp?: unknown }>,
): KnownPeer[] {
  return peers.map((peer) => {
    const { customIp: _legacyCustomIp, ...currentPeer } = peer;
    return currentPeer;
  });
}

function deleteStoredFileData(
  handleKeys: string[],
  resourceKeys: string[],
): void {
  void Promise.allSettled(
    [
      ...handleKeys.map((handleKey) => deleteFileHandle(handleKey)),
      ...resourceKeys.map((resourceKey) =>
        deleteCachedResourceFile(resourceKey),
      ),
    ],
  );
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      deviceName: initialDeviceName(),
      theme: "system",
      peers: [],
      messages: [],
      setDeviceName: (deviceName) => {
        saveFirstDeviceName(localStorage, deviceName);
        set({ deviceName });
      },
      setTheme: (theme) => set({ theme }),
      upsertPeer: (peer, rendezvous) =>
        set((state) => ({
          peers: [
            {
              ...state.peers.find(
                (item) => item.deviceId === peer.deviceId,
              ),
              ...peer,
              lastConnectedAt: Date.now(),
              ...(rendezvous
                ? {
                    connectionCode: rendezvous.code,
                    connectionToken: rendezvous.token,
                  }
                : {}),
            },
            ...state.peers.filter(
              (item) => item.deviceId !== peer.deviceId,
            ),
          ],
        })),
      removeConversation: async (deviceId) => {
        const removedMessages = get().messages.filter(
          (message) => message.conversationId === deviceId,
        );
        const removedHandleKeys = removedMessages.flatMap((message) =>
          message.file?.handleKey ? [message.file.handleKey] : [],
        );
        const removedResourceKeys = removedMessages.flatMap((message) =>
          message.file?.resourceKey ? [message.file.resourceKey] : [],
        );
        try {
          await Promise.all([
            ...removedHandleKeys.map((handleKey) =>
              deleteFileHandle(handleKey),
            ),
            ...removedResourceKeys.map((resourceKey) =>
              deleteCachedResourceFileStrict(resourceKey),
            ),
          ]);
          set((state) => ({
            peers: state.peers.filter(
              (peer) => peer.deviceId !== deviceId,
            ),
            messages: state.messages.filter(
              (message) => message.conversationId !== deviceId,
            ),
          }));
          return true;
        } catch {
          return false;
        }
      },
      addMessage: (message) => {
        let prunedHandleKeys: string[] = [];
        let prunedResourceKeys: string[] = [];
        set((state) => {
          if (state.messages.some((item) => item.id === message.id)) {
            return state;
          }
          const appended = [...state.messages, message];
          const pruned = appended.slice(0, Math.max(0, appended.length - 5_000));
          prunedHandleKeys = pruned.flatMap((item) =>
            item.file?.handleKey ? [item.file.handleKey] : [],
          );
          prunedResourceKeys = pruned.flatMap((item) =>
            item.file?.resourceKey ? [item.file.resourceKey] : [],
          );
          return { messages: appended.slice(-5_000) };
        });
        deleteStoredFileData(prunedHandleKeys, prunedResourceKeys);
      },
      removeMessage: (id) => {
        let removedHandleKeys: string[] = [];
        let removedResourceKeys: string[] = [];
        set((state) => {
          const removed = state.messages.find(
            (message) => message.id === id,
          );
          if (!removed) return state;
          removedHandleKeys = removed.file?.handleKey
            ? [removed.file.handleKey]
            : [];
          removedResourceKeys = removed.file?.resourceKey
            ? [removed.file.resourceKey]
            : [];
          return {
            messages: state.messages.filter(
              (message) => message.id !== id,
            ),
          };
        });
        deleteStoredFileData(removedHandleKeys, removedResourceKeys);
      },
      updateMessage: (id, patch) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, ...patch } : message,
          ),
        })),
      setMessagePinned: (id, pinnedAt) =>
        set((state) => ({
          messages: state.messages.map((message) => {
            if (message.id !== id) return message;
            if (pinnedAt !== null) return { ...message, pinnedAt };
            const { pinnedAt: _pinnedAt, ...unpinned } = message;
            return unpinned;
          }),
        })),
    }),
    {
      name: "peerto-app-v3",
      version: 1,
      migrate: (persistedState) => {
        const persisted = persistedState as Partial<AppState> & {
          peers?: Array<KnownPeer & { customIp?: unknown }>;
        };
        return {
          ...persisted,
          ...(persisted.peers
            ? { peers: withoutLegacyCustomIps(persisted.peers) }
            : {}),
        } as AppState;
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AppState> & {
          peers?: Array<KnownPeer & { customIp?: unknown }>;
        };
        const peers = withoutLegacyCustomIps(
          persisted.peers || currentState.peers,
        );
        return { ...currentState, ...persisted, peers };
      },
    },
  ),
);

export const SAVED_CONVERSATION_ID = "saved";
