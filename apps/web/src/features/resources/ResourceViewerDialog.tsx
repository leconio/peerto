import {
  DownloadSimple,
  File as FileIcon,
  Trash,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import { Modal } from "../../components/Modal";
import { formatBytes } from "../../lib/format";
import type { StoredMessage } from "../../store";
import {
  isImageFile,
  isVideoFile,
} from "./resource-access";

export interface ResourceViewerState {
  message: StoredMessage;
  url: string;
  previewFailed?: boolean;
}

export interface ResourceViewerDialogProps {
  viewer: ResourceViewerState;
  onClose: () => void;
  onPreviewFailed: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

export function ResourceViewerDialog({
  viewer,
  onClose,
  onPreviewFailed,
  onDownload,
  onDelete,
}: ResourceViewerDialogProps) {
  const { t } = useTranslation();
  const file = viewer.message.file;
  if (!file) return null;

  return (
    <Modal title={file.name} onClose={onClose} wide>
      <div className={styles.resourceViewer}>
        <div className={styles.resourcePreviewViewport}>
          {!viewer.previewFailed && isImageFile(file) ? (
            <img
              src={viewer.url}
              alt={file.name}
              onError={onPreviewFailed}
            />
          ) : !viewer.previewFailed && isVideoFile(file) ? (
            <video
              src={viewer.url}
              controls
              autoPlay
              playsInline
              onError={onPreviewFailed}
            />
          ) : (
            <div className={styles.resourceDocumentPreview}>
              <FileIcon size={58} weight="duotone" />
              <strong>{file.name}</strong>
              <small>{formatBytes(file.size)}</small>
              {viewer.previewFailed && (
                <span>{t("resources.previewUnsupported")}</span>
              )}
            </div>
          )}
        </div>
        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onDownload}
          >
            <DownloadSimple size={18} />
            {t("resources.download")}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={onDelete}
          >
            <Trash size={18} />
            {t("resources.delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
