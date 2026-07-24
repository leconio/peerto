import type {
  ChangeEvent,
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import type { ToastNotice } from "../../components/Toast";
import { putFileHandle } from "../../lib/database";
import { errorNotice } from "../../lib/error-notice";
import type { LocalIdentity } from "../../lib/identity";
import {
  cacheLocalResourceFile,
  deleteCachedResourceFile,
  supportsOriginPrivateFileSystem,
} from "../../services/file-transfer";
import type { PeerClient } from "../../services/peer";
import {
  SAVED_CONVERSATION_ID,
  type StoredMessage,
  useAppStore,
} from "../../store";
import { replyReference } from "../messages/message-utils";
import type { TransferProgress } from "./types";

export interface FileSelectionBindings {
  identity: LocalIdentity | undefined;
  replyingTo: StoredMessage | undefined;
  selectedId: string;
  onlineForSelection: boolean;
  client: PeerClient | undefined;
  openFilePickerAvailable: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  setOpenFilePickerAvailable: Dispatch<SetStateAction<boolean>>;
  setReplyingTo: Dispatch<
    SetStateAction<StoredMessage | undefined>
  >;
  setNotice: Dispatch<SetStateAction<ToastNotice | undefined>>;
  setProgress: Dispatch<
    SetStateAction<Record<string, TransferProgress>>
  >;
  addMessage: (message: StoredMessage) => void;
  updateMessage: (
    id: string,
    patch: Partial<Pick<StoredMessage, "status" | "file">>,
  ) => void;
}

export function useFileSelection({
  identity,
  replyingTo,
  selectedId,
  onlineForSelection,
  client,
  openFilePickerAvailable,
  fileInputRef,
  setOpenFilePickerAvailable,
  setReplyingTo,
  setNotice,
  setProgress,
  addMessage,
  updateMessage,
}: FileSelectionBindings) {
  const processSelectedFile = async (
    file: File,
    handle?: FileSystemFileHandle,
  ) => {
    if (!identity) return;
    const replyTo = replyReference(replyingTo);
    if (selectedId === SAVED_CONVERSATION_ID) {
      const id = crypto.randomUUID();
      const handleKey = handle ? `file:${id}` : undefined;
      const resourceKey = handle
        ? undefined
        : await cacheLocalResourceFile(file, id);
      if (!handleKey && !resourceKey) {
        setNotice({ key: "error.OPEN_FILE_UNSUPPORTED" });
        return;
      }
      if (handle && handleKey) await putFileHandle(handleKey, handle);
      addMessage({
        id,
        conversationId: SAVED_CONVERSATION_ID,
        senderId: identity.device.deviceId,
        kind: "file",
        file: {
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          ...(handleKey ? { handleKey } : {}),
          ...(resourceKey ? { resourceKey } : {}),
        },
        ...(replyTo ? { replyTo } : {}),
        createdAt: Date.now(),
        status: "local",
      });
      setReplyingTo(undefined);
      return;
    }
    if (!onlineForSelection || !client) {
      setNotice({ key: "error.DEVICE_OFFLINE" });
      return;
    }
    const offer = client.offerFile(file, replyTo);
    const handleKey = handle ? `file:${offer.messageId}` : undefined;
    if (handle && handleKey) await putFileHandle(handleKey, handle);
    addMessage({
      id: offer.messageId,
      conversationId: selectedId,
      senderId: identity.device.deviceId,
      kind: "file",
      file: {
        name: offer.name,
        size: offer.size,
        mime: offer.mime,
        ...(handleKey ? { handleKey } : {}),
      },
      ...(offer.replyTo ? { replyTo: offer.replyTo } : {}),
      createdAt: offer.createdAt,
      status: "sending",
    });
    setProgress((current) => ({
      ...current,
      [offer.messageId]: {
        direction: "send",
        transferred: 0,
        total: offer.size,
      },
    }));
    if (!handle && supportsOriginPrivateFileSystem()) {
      void cacheLocalResourceFile(file, offer.messageId).then(
        async (resourceKey) => {
          if (!resourceKey) return;
          const storedMessage = useAppStore
            .getState()
            .messages.find((message) => message.id === offer.messageId);
          if (!storedMessage?.file) {
            await deleteCachedResourceFile(resourceKey);
            return;
          }
          updateMessage(offer.messageId, {
            file: { ...storedMessage.file, resourceKey },
          });
        },
      );
    }
    setReplyingTo(undefined);
  };

  const selectFile = async () => {
    if (openFilePickerAvailable && window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
        });
        if (!handle) return;
        await processSelectedFile(await handle.getFile(), handle);
        return;
      } catch (error) {
        if ((error as DOMException).name === "AbortError") return;
        setOpenFilePickerAvailable(false);
      }
    }
    fileInputRef.current?.click();
  };

  const onMobileFileSelected = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void processSelectedFile(file).catch((error) =>
      setNotice(errorNotice(error, "error.SELECT_FILE_FAILED")),
    );
  };

  return { onMobileFileSelected, selectFile };
}
