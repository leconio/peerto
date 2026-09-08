import type {
  DeviceIdentity,
  RendezvousInfo,
} from "@peerto/protocol";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { ToastNotice } from "../../components/Toast";
import { deleteFileHandle } from "../../lib/database";
import { formatBytes } from "../../lib/format";
import type { ConnectionRoute } from "../../lib/network";
import {
  type ConnectionDialogKind,
} from "../connection/ConnectionDialogs";
import type { TransferProgress } from "../transfers/types";
import {
  type ConnectionStatus,
  type IceAddressSnapshot,
  type PeerClient,
  type PeerClientCallbacks,
  type RoomInfo,
  type RuntimeCode,
} from "../../services/peer";
import { runtimeKey } from "../../services/peer/runtime-key";
import { deleteCachedResourceFile } from "../../services/file-transfer";
import { canPeerDeleteMessage } from "../messages/message-delete";
import type {
  KnownPeer,
  StoredFile,
  StoredMessage,
} from "../../store";
import { useAppStore } from "../../store";
import { shouldOpenPeerConversation } from "./peer-session-scope";

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface PeerCallbackBindings {
  peerIdRef: MutableRefObject<string | undefined>;
  selectedIdRef: MutableRefObject<string>;
  peersRef: MutableRefObject<KnownPeer[]>;
  sharedJoinHandledRef: MutableRefObject<boolean>;
  getClient: () => PeerClient | undefined;
  isPairingClient?: () => boolean;
  setStatus: Setter<ConnectionStatus>;
  setStatusDetail: Setter<RuntimeCode>;
  setConnectionDialog: Setter<ConnectionDialogKind>;
  setRoom: Setter<RoomInfo | undefined>;
  setJoinRequest: Setter<DeviceIdentity | undefined>;
  onPeerConnected?: (
    peer: DeviceIdentity,
    restored: boolean,
  ) => void;
  setSelectedId: Setter<string>;
  setMobileConversation: Setter<boolean>;
  setReplyingTo: Setter<StoredMessage | undefined>;
  setPinnedCursor: Setter<number>;
  setProgress: Setter<Record<string, TransferProgress>>;
  setNotice: Setter<ToastNotice | undefined>;
  setIpProbing: Setter<boolean>;
  setIceSnapshot: Setter<IceAddressSnapshot | undefined>;
  setConnectionRoute: Setter<ConnectionRoute | undefined>;
  upsertPeer: (
    peer: DeviceIdentity,
    rendezvous?: RendezvousInfo,
  ) => void;
  addMessage: (message: StoredMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (
    id: string,
    update: Partial<StoredMessage>,
  ) => void;
  setMessagePinned: (
    id: string,
    pinnedAt: number | null,
  ) => void;
  onRemoteConversationDelete: (
    peerId: string,
  ) => Promise<boolean>;
}

export function createPeerCallbacks(
  bindings: PeerCallbackBindings,
): PeerClientCallbacks {
  const {
    peerIdRef,
    selectedIdRef,
    peersRef,
    sharedJoinHandledRef,
    getClient,
    isPairingClient = () => true,
    setStatus,
    setStatusDetail,
    setConnectionDialog,
    setRoom,
    setJoinRequest,
    onPeerConnected,
    setSelectedId,
    setMobileConversation,
    setReplyingTo,
    setPinnedCursor,
    setProgress,
    setNotice,
    setIpProbing,
    setIceSnapshot,
    setConnectionRoute,
    upsertPeer,
    addMessage,
    removeMessage,
    updateMessage,
    setMessagePinned,
    onRemoteConversationDelete,
  } = bindings;

  return {
    onStatus: (nextStatus, detail) => {
      setStatus(nextStatus);
      setStatusDetail(detail || "ready");
      if (!isPairingClient()) return;
      if (nextStatus === "online") {
        setConnectionDialog(null);
        setRoom(undefined);
        setJoinRequest(undefined);
      } else if (
        nextStatus === "offline" || nextStatus === "network_offline" ||
        nextStatus === "failed"
      ) {
        setRoom(undefined);
      }
    },
    onRoom: (nextRoom) => {
      if (!isPairingClient()) return;
      setRoom(nextRoom);
      setConnectionDialog("host");
    },
    onPublicAddresses: setIceSnapshot,
    onAddressProbeState: setIpProbing,
    onConnectionRoute: setConnectionRoute,
    onJoinRequest: (device) => {
      if (isPairingClient()) setJoinRequest(device);
    },
    onPeer: (peer, rendezvous, restored) => {
      const pairingConnection = isPairingClient();
      if (pairingConnection) sharedJoinHandledRef.current = false;
      peerIdRef.current = peer.deviceId;
      onPeerConnected?.(peer, Boolean(restored));
      if (pairingConnection) setConnectionDialog(null);
      upsertPeer(peer, rendezvous);
      if (
        shouldOpenPeerConversation(
          pairingConnection,
          selectedIdRef.current,
          peer.deviceId,
        )
      ) {
        setSelectedId(peer.deviceId);
        setMobileConversation(true);
      }
      if (!restored && pairingConnection) {
        setReplyingTo(undefined);
        setPinnedCursor(0);
      }
    },
    onText: (message) => {
      const conversationId = peerIdRef.current;
      if (!conversationId) return;
      addMessage({
        id: message.id,
        conversationId,
        senderId: conversationId,
        kind: "text",
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        createdAt: message.createdAt,
        status: "delivered",
      });
    },
    onAck: (id) => updateMessage(id, { status: "delivered" }),
    onMessagePin: setMessagePinned,
    onMessageDelete: (messageId) => {
      const message = useAppStore
        .getState()
        .messages.find((item) => item.id === messageId);
      if (
        !canPeerDeleteMessage(message, peerIdRef.current)
      ) {
        return false;
      }
      if (message) {
        removeMessage(messageId);
        setReplyingTo((current) =>
          current?.id === messageId ? undefined : current,
        );
        setPinnedCursor(0);
        setProgress((current) => {
          const next = { ...current };
          delete next[messageId];
          return next;
        });
      }
      return true;
    },
    onMessageDeleteResult: (_messageId, deleted) => {
      if (!deleted) {
        setNotice({ key: "message.deleteRemoteFailed" });
      }
    },
    onConversationDelete: async () => {
      const peerId = peerIdRef.current;
      return peerId
        ? onRemoteConversationDelete(peerId)
        : false;
    },
    onFileOffer: (offer) => {
      const conversationId = peerIdRef.current;
      const client = getClient();
      if (!conversationId || !client) {
        client?.rejectFile(offer.transferId, "RECEIVER_NOT_READY");
        return;
      }
      addMessage({
        id: offer.messageId,
        conversationId,
        senderId: conversationId,
        kind: "file",
        file: {
          name: offer.name,
          size: offer.size,
          mime: offer.mime,
        },
        ...(offer.replyTo ? { replyTo: offer.replyTo } : {}),
        createdAt: offer.createdAt,
        status: "sending",
      });
      setProgress((current) => ({
        ...current,
        [offer.messageId]: {
          direction: "receive",
          transferred: 0,
          total: offer.size,
        },
      }));
      void client
        .acceptFile(offer.transferId)
        .then((receiveMode) => {
          if (receiveMode === "memory") {
            setNotice({
              key: "fileDialog.memoryFallback",
              values: { size: formatBytes(offer.size) },
            });
          }
        })
        .catch(() => {
          const stillExists = useAppStore
            .getState()
            .messages.some((message) => message.id === offer.messageId);
          if (!stillExists) return;
          updateMessage(offer.messageId, { status: "failed" });
          setProgress((current) => {
            const next = { ...current };
            delete next[offer.messageId];
            return next;
          });
          setNotice({ key: "error.CREATE_FILE_FAILED" });
        });
    },
    onFileProgress: (messageId, direction, transferred, total) => {
      setProgress((current) => ({
        ...current,
        [messageId]: { direction, transferred, total },
      }));
    },
    onFileSent: (messageId, delivered) => {
      updateMessage(messageId, {
        status: delivered ? "delivered" : "sent",
      });
      setProgress((current) => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
    },
    onFileReceived: (file) => {
      const conversationId = peerIdRef.current;
      if (!conversationId) {
        if (file.handleKey) void deleteFileHandle(file.handleKey);
        if (file.resourceKey) {
          void deleteCachedResourceFile(file.resourceKey);
        }
        return;
      }
      const storedFile: StoredFile = {
        name: file.name,
        size: file.size,
        mime: file.mime,
        ...(file.handleKey ? { handleKey: file.handleKey } : {}),
        ...(file.resourceKey ? { resourceKey: file.resourceKey } : {}),
      };
      const existing = useAppStore
        .getState()
        .messages.some((message) => message.id === file.messageId);
      if (existing) {
        updateMessage(file.messageId, {
          file: storedFile,
          status: "delivered",
        });
      } else {
        addMessage({
          id: file.messageId,
          conversationId,
          senderId: conversationId,
          kind: "file",
          file: storedFile,
          ...(file.replyTo ? { replyTo: file.replyTo } : {}),
          createdAt: file.createdAt,
          status: "delivered",
        });
      }
      setProgress((current) => {
        const next = { ...current };
        delete next[file.messageId];
        return next;
      });
    },
    onFileRejected: (messageId, reason) => {
      updateMessage(messageId, { status: "failed" });
      setNotice({ key: runtimeKey(reason || "fileRejected") });
      setProgress((current) => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
    },
    onFileCancelled: (messageId) => {
      const message = useAppStore
        .getState()
        .messages.find((item) => item.id === messageId);
      if (message?.kind === "file" && message.status === "sending") {
        removeMessage(messageId);
        setReplyingTo((current) =>
          current?.id === messageId ? undefined : current,
        );
        setPinnedCursor(0);
      }
      setProgress((current) => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
    },
    onError: (code) => setNotice({ key: runtimeKey(code) }),
  };
}
