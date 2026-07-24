import type {
  Dispatch,
  FormEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { ToastNotice } from "../../components/Toast";
import { canReuseHostRoom } from "../../lib/host-room";
import { errorNotice } from "../../lib/error-notice";
import {
  PeerClient,
  PeerClientError,
  type ConnectionStatus,
  type RoomInfo,
  type RuntimeCode,
} from "../../services/peer";
import type { ConversationRetryState } from "../../services/conversation-retry";
import {
  SAVED_CONVERSATION_ID,
  type StoredMessage,
} from "../../store";
import { runtimeKey } from "../../services/peer/runtime-key";
import type { ConnectionDialogKind } from "./ConnectionDialogs";

export interface ConnectionActionsBindings {
  client: PeerClient | undefined;
  room: RoomInfo | undefined;
  ipProbing: boolean;
  joinCode: string;
  getPeerClient: (peerId: string) => PeerClient | undefined;
  activatePeerClient: (peerId: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setConversationRetry: Dispatch<
    SetStateAction<ConversationRetryState | undefined>
  >;
  setPeerMenuOpen: Dispatch<SetStateAction<boolean>>;
  setReplyingTo: Dispatch<
    SetStateAction<StoredMessage | undefined>
  >;
  setPinnedCursor: Dispatch<SetStateAction<number>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setMobileConversation: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<ToastNotice | undefined>>;
  setPeerOffline: (peerId: string, detail: RuntimeCode) => void;
  setRoom: Dispatch<SetStateAction<RoomInfo | undefined>>;
  setConnectionDialog: Dispatch<
    SetStateAction<ConnectionDialogKind>
  >;
  setStatus: Dispatch<SetStateAction<ConnectionStatus>>;
  setStatusDetail: Dispatch<SetStateAction<RuntimeCode>>;
  requestHumanVerification: () => Promise<string>;
}

export function useConnectionActions({
  client,
  room,
  ipProbing,
  joinCode,
  getPeerClient,
  activatePeerClient,
  inputRef,
  setConversationRetry,
  setPeerMenuOpen,
  setReplyingTo,
  setPinnedCursor,
  setSelectedId,
  setMobileConversation,
  setNotice,
  setPeerOffline,
  setRoom,
  setConnectionDialog,
  setStatus,
  setStatusDetail,
  requestHumanVerification,
}: ConnectionActionsBindings) {
  const selectConversation = (id: string) => {
    setPeerMenuOpen(false);
    setReplyingTo(undefined);
    setPinnedCursor(0);
    setSelectedId(id);
    setMobileConversation(true);
    setNotice(undefined);
    if (id === SAVED_CONVERSATION_ID) {
      setConversationRetry(undefined);
    } else {
      activatePeerClient(id);
      if (!getPeerClient(id)?.isOnline) {
        setConversationRetry({
          peerId: id,
          attempt: 1,
          phase: "attempting",
        });
      }
    }
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const retryConversationImmediately = () => {
    setConversationRetry((current) => {
      if (!current) return current;
      getPeerClient(current.peerId)?.disconnect(false);
      return {
        peerId: current.peerId,
        attempt: current.attempt + 1,
        phase: "attempting",
      };
    });
  };

  const cancelConversationRetry = () => {
    setConversationRetry((current) => {
      if (current) {
        getPeerClient(current.peerId)?.disconnect(false);
        setPeerOffline(
          current.peerId,
          navigator.onLine ? "peerOffline" : "networkOffline",
        );
      }
      return undefined;
    });
  };

  const refreshPublicAddresses = async () => {
    if (!client || ipProbing || !navigator.onLine) return;
    try {
      await client.probePublicAddresses();
      setNotice({ key: "ip.refreshed" });
    } catch (error) {
      setNotice(errorNotice(error, "error.IP_REFRESH_FAILED"));
    }
  };

  const createRoom = async () => {
    if (!client) return;
    setConversationRetry(undefined);
    setNotice(undefined);
    if (canReuseHostRoom(room, client.activeHostRoomCode)) {
      setConnectionDialog("host");
      return;
    }
    setRoom(undefined);
    setConnectionDialog("host");
    try {
      await client.startHost();
    } catch (error) {
      if (
        error instanceof PeerClientError &&
        error.code === "TURNSTILE_REQUIRED"
      ) {
        try {
          const token = await requestHumanVerification();
          await client.startHost(token);
          return;
        } catch (verificationError) {
          error = verificationError;
        }
      }
      setConnectionDialog(null);
      setRoom(undefined);
      setStatus("failed");
      if (error instanceof PeerClientError) {
        const code = `server.${error.code}` as RuntimeCode;
        setStatusDetail(code);
        setNotice({ key: runtimeKey(code) });
      } else {
        setStatusDetail("signalingUnavailable");
        setNotice(errorNotice(error, "error.CREATE_ROOM_FAILED"));
      }
    }
  };

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!client || joinCode.length !== 6) return;
    setConversationRetry(undefined);
    setRoom(undefined);
    client.join(joinCode);
  };

  return {
    cancelConversationRetry,
    createRoom,
    refreshPublicAddresses,
    retryConversationImmediately,
    selectConversation,
    submitJoin,
  };
}
