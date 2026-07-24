import type {
  Dispatch,
  SetStateAction,
} from "react";
import { deleteFileHandle } from "../../lib/database";
import { errorNotice } from "../../lib/error-notice";
import {
  deleteCachedResourceFile,
  downloadBlob,
} from "../../services/file-transfer";
import { PeerClientError } from "../../services/peer";
import type { StoredMessage } from "../../store";
import type { ToastNotice } from "../../components/Toast";
import { readStoredResourceFile } from "./resource-access";
import type { ResourceViewerState } from "./ResourceViewerDialog";

export interface ResourceActionsBindings {
  resourceMessages: StoredMessage[];
  resourceViewer: ResourceViewerState | undefined;
  setResourceViewer: Dispatch<
    SetStateAction<ResourceViewerState | undefined>
  >;
  setNotice: Dispatch<SetStateAction<ToastNotice | undefined>>;
  updateMessage: (
    id: string,
    patch: Partial<Pick<StoredMessage, "status" | "file">>,
  ) => void;
}

export function useResourceActions({
  resourceMessages,
  resourceViewer,
  setResourceViewer,
  setNotice,
  updateMessage,
}: ResourceActionsBindings) {
  const closeResourceViewer = () => {
    setResourceViewer((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return undefined;
    });
  };

  const downloadStoredResource = async (message: StoredMessage) => {
    if (!message.file) {
      setNotice({ key: "error.HANDLE_MISSING" });
      return;
    }
    try {
      const file = await readStoredResourceFile(message.file, true);
      if (!file) throw new PeerClientError("HANDLE_MISSING");
      downloadBlob(file, message.file.name);
    } catch (error) {
      setNotice(errorNotice(error, "error.READ_FILE_FAILED"));
    }
  };

  const openResourcePreview = async (message: StoredMessage) => {
    if (!message.file) return;
    try {
      const file = await readStoredResourceFile(message.file, true);
      if (!file) throw new PeerClientError("HANDLE_MISSING");
      const url = URL.createObjectURL(file);
      setResourceViewer((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { message, url };
      });
    } catch (error) {
      setNotice(errorNotice(error, "error.READ_FILE_FAILED"));
    }
  };

  const deleteStoredResource = async (message: StoredMessage) => {
    const file = message.file;
    if (!file) return;
    await Promise.allSettled([
      ...(file.handleKey
        ? [deleteFileHandle(file.handleKey)]
        : []),
      ...(file.resourceKey
        ? [deleteCachedResourceFile(file.resourceKey)]
        : []),
    ]);
    const {
      handleKey: _handleKey,
      resourceKey: _resourceKey,
      ...metadata
    } = file;
    updateMessage(message.id, { file: metadata });
    if (resourceViewer?.message.id === message.id) {
      closeResourceViewer();
    }
  };

  const clearStoredResources = async () => {
    await Promise.allSettled(
      resourceMessages.flatMap((message) => [
        ...(message.file?.handleKey
          ? [deleteFileHandle(message.file.handleKey)]
          : []),
        ...(message.file?.resourceKey
          ? [deleteCachedResourceFile(message.file.resourceKey)]
          : []),
      ]),
    );
    for (const message of resourceMessages) {
      if (!message.file) continue;
      const {
        handleKey: _handleKey,
        resourceKey: _resourceKey,
        ...metadata
      } = message.file;
      updateMessage(message.id, { file: metadata });
    }
    closeResourceViewer();
    setNotice({ key: "resources.cleared" });
  };

  return {
    clearStoredResources,
    closeResourceViewer,
    deleteStoredResource,
    downloadStoredResource,
    openResourcePreview,
  };
}
