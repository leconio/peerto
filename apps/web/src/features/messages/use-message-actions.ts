import type {
  Dispatch,
  KeyboardEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { ToastNotice } from "../../components/Toast";
import type { LocalIdentity } from "../../lib/identity";
import type { PeerClient } from "../../services/peer";
import {
  SAVED_CONVERSATION_ID,
  type StoredMessage,
} from "../../store";
import {
  replyReference,
} from "./message-utils";
import type { MessageJumpTarget } from "./types";

export interface MessageActionsBindings {
  selectedId: string;
  identity: LocalIdentity | undefined;
  replyingTo: StoredMessage | undefined;
  draft: string;
  client: PeerClient | undefined;
  onlineForSelection: boolean;
  activePinnedMessage: StoredMessage | undefined;
  pinnedMessages: StoredMessage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setReplyingTo: Dispatch<
    SetStateAction<StoredMessage | undefined>
  >;
  setDraft: Dispatch<SetStateAction<string>>;
  setPinnedCursor: Dispatch<SetStateAction<number>>;
  setMessageJumpTarget: Dispatch<
    SetStateAction<MessageJumpTarget | undefined>
  >;
  setNotice: Dispatch<SetStateAction<ToastNotice | undefined>>;
  addMessage: (message: StoredMessage) => void;
  removeMessage: (id: string) => void;
  setMessagePinned: (id: string, pinnedAt: number | null) => void;
}

export function useMessageActions({
  selectedId,
  identity,
  replyingTo,
  draft,
  client,
  onlineForSelection,
  activePinnedMessage,
  pinnedMessages,
  inputRef,
  setReplyingTo,
  setDraft,
  setPinnedCursor,
  setMessageJumpTarget,
  setNotice,
  addMessage,
  removeMessage,
  setMessagePinned,
}: MessageActionsBindings) {
  const requestMessageJump = (messageId: string) => {
    setMessageJumpTarget((current) => ({
      messageId,
      requestId: (current?.requestId || 0) + 1,
    }));
  };

  const startReply = (message: StoredMessage) => {
    if (message.conversationId !== selectedId) return;
    setReplyingTo(message);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const toggleMessagePin = (message: StoredMessage) => {
    if (message.conversationId !== selectedId) return;
    const pinnedAt = message.pinnedAt ? null : Date.now();
    setMessagePinned(message.id, pinnedAt);
    setPinnedCursor(0);

    if (
      selectedId !== SAVED_CONVERSATION_ID &&
      (!onlineForSelection ||
        !client?.sendMessagePin(message.id, pinnedAt))
    ) {
      setNotice({ key: "message.pinLocalOnly" });
    }
  };

  const openActivePinnedMessage = () => {
    if (!activePinnedMessage) return;
    requestMessageJump(activePinnedMessage.id);
    setPinnedCursor((current) =>
      pinnedMessages.length > 1
        ? (current + 1) % pinnedMessages.length
        : 0,
    );
  };

  const deleteOwnMessage = (message: StoredMessage) => {
    if (
      !identity ||
      message.conversationId !== selectedId ||
      message.senderId !== identity.device.deviceId
    ) {
      return;
    }

    if (selectedId === SAVED_CONVERSATION_ID) {
      removeMessage(message.id);
    } else if (!onlineForSelection || !client) {
      setNotice({ key: "message.deleteUnavailable" });
      return;
    } else if (
      message.kind === "file" &&
      message.status === "sending"
    ) {
      if (!client.cancelFile(message.id)) {
        setNotice({ key: "message.deleteUnavailable" });
        return;
      }
    } else {
      if (!client.deleteMessage(message.id)) {
        setNotice({ key: "message.deleteUnavailable" });
        return;
      }
      removeMessage(message.id);
    }

    setReplyingTo((current) =>
      current?.id === message.id ? undefined : current,
    );
    setPinnedCursor(0);
  };

  const sendMessage = () => {
    const text = draft.trim();
    if (!text || !identity) return;
    const replyTo = replyReference(replyingTo);
    const message: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId: selectedId,
      senderId: identity.device.deviceId,
      kind: "text",
      text,
      ...(replyTo ? { replyTo } : {}),
      createdAt: Date.now(),
      status:
        selectedId === SAVED_CONVERSATION_ID ? "local" : "sending",
    };
    if (
      selectedId !== SAVED_CONVERSATION_ID &&
      !client?.sendText(message.id, text, message.createdAt, replyTo)
    ) {
      setNotice({ key: "error.DEVICE_OFFLINE" });
      return;
    }
    addMessage(message);
    setDraft("");
    setReplyingTo(undefined);
  };

  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Escape" && replyingTo) {
      event.preventDefault();
      setReplyingTo(undefined);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return {
    deleteOwnMessage,
    handleComposerKeyDown,
    openActivePinnedMessage,
    requestMessageJump,
    sendMessage,
    startReply,
    toggleMessagePin,
  };
}
