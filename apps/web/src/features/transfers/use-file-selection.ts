import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { useEffect, useRef, useState } from "react";
import type { ToastNotice } from "../../components/Toast";
import { putFileHandle } from "../../lib/database";
import { errorNotice } from "../../lib/error-notice";
import type { LocalIdentity } from "../../lib/identity";
import {
  cacheLocalResourceFile,
  deleteCachedResourceFile,
  supportsOriginPrivateFileSystem,
  MAX_QUEUED_FILES,
} from "../../services/file-transfer";
import type { PeerClient } from "../../services/peer";
import {
  SAVED_CONVERSATION_ID,
  type StoredMessage,
  useAppStore,
} from "../../store";
import { replyReference } from "../messages/message-utils";
import type { TransferProgress } from "./types";
import { clipboardFiles, insertPastedText, type PendingAttachment } from "./clipboard";

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
  setDraft: Dispatch<SetStateAction<string>>;
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
  setDraft,
}: FileSelectionBindings) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const pendingRef = useRef<PendingAttachment[]>([]);
  const pendingOwner = useRef<{ selectedId: string; client: PeerClient | undefined } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const currentTarget = useRef({ selectedId, client });
  currentTarget.current = { selectedId, client };
  const replacePending = (files: PendingAttachment[]) => { pendingRef.current = files; setPending(files); };
  useEffect(() => {
    pendingRef.current = [];
    pendingOwner.current = undefined;
    setPending([]);
  }, [selectedId, client]);
  const targetIsCurrent = () => currentTarget.current.selectedId === selectedId && currentTarget.current.client === client;
  const pendingIsCurrent = () => pendingOwner.current?.selectedId === selectedId && pendingOwner.current.client === client;

  const processSelectedFile = async (
    file: File,
    handle?: FileSystemFileHandle,
  ) => {
    if (!identity || !targetIsCurrent()) return false;
    const replyTo = replyReference(replyingTo);
    if (selectedId === SAVED_CONVERSATION_ID) {
      const id = crypto.randomUUID();
      const handleKey = handle ? `file:${id}` : undefined;
      const resourceKey = handle
        ? undefined
        : await cacheLocalResourceFile(file, id);
      if (!handleKey && !resourceKey) {
        setNotice({ key: "error.OPEN_FILE_UNSUPPORTED" });
        return false;
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
      return true;
    }
    if (!onlineForSelection || !client?.isOnline) {
      setNotice({ key: "error.DEVICE_OFFLINE" });
      return false;
    }
    const offer = client.offerFile(file, replyTo);
    const handleKey = handle ? `file:${offer.messageId}` : undefined;
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
    // Once queued, persistence errors must not offer the same file twice.
    if (handle && handleKey) {
      void putFileHandle(handleKey, handle).catch(() => setNotice({ key: "error.SELECT_FILE_FAILED" }));
    }
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
      ).catch(() => setNotice({ key: "error.SELECT_FILE_FAILED" }));
    }
    setReplyingTo(undefined);
    return true;
  };

  const stageAttachments = (files: { file: File; handle?: FileSystemFileHandle }[]) => {
    if (!targetIsCurrent() || sendingRef.current || !files.length) return;
    const current = pendingIsCurrent() ? pendingRef.current : [];
    if (files.length + current.length > MAX_QUEUED_FILES) {
      setNotice({ key: "error.FILE_QUEUE_FULL" });
      return;
    }
    pendingOwner.current = { selectedId, client };
    replacePending([...current, ...files.map(item => ({ ...item, id: crypto.randomUUID() }))]);
  };

  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return; // Let the browser insert plain text normally.
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      const input = event.currentTarget;
      const inserted = insertPastedText(input.value, input.selectionStart, input.selectionEnd, text);
      setDraft(inserted.value);
      window.requestAnimationFrame(() => {
        if (input.isConnected) input.setSelectionRange(inserted.caret, inserted.caret);
      });
    }
    stageAttachments(files.map(file => ({ file })));
  };

  const confirmAttachments = async () => {
    if (sendingRef.current || !targetIsCurrent() || !pendingIsCurrent()) return;
    sendingRef.current = true;
    setSending(true);
    try {
      for (const attachment of pendingRef.current) {
        if (!targetIsCurrent()) break;
        try {
          if (await processSelectedFile(attachment.file, attachment.handle)) {
            replacePending(pendingRef.current.filter(item => item.id !== attachment.id));
          } else break;
        } catch (error) {
          setNotice(errorNotice(error, "error.SELECT_FILE_FAILED"));
          // Keep unqueued files for an explicit retry; never repeat successes.
          break;
        }
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const selectFile = async () => {
    if (openFilePickerAvailable && window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
        });
        if (handles.length > MAX_QUEUED_FILES) {
          setNotice({ key: "error.FILE_QUEUE_FULL" });
          return;
        }
        stageAttachments(await Promise.all(handles.map(async handle => ({ file: await handle.getFile(), handle }))));
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
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    stageAttachments(files.map(file => ({ file })));
  };

  return {
    onMobileFileSelected, selectFile, onComposerPaste, pendingAttachments: pendingIsCurrent() ? pending : [],
    attachmentsSending: sending, confirmAttachments,
    cancelAttachments: () => { if (!sendingRef.current) replacePending([]); },
    removeAttachment: (id: string) => { if (!sendingRef.current) replacePending(pendingRef.current.filter(item => item.id !== id)); },
  };
}
