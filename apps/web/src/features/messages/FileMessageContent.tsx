import {
  File as FileIcon,
  StopCircle,
} from "@phosphor-icons/react";
import {
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import { formatBytes } from "../../lib/format";
import type { StoredMessage } from "../../store";
import type { TransferProgress } from "../transfers/types";
import {
  isImageFile,
  isVideoFile,
} from "../resources/resource-access";
import { useResourceObjectUrl } from "../resources/use-resource-object-url";

export interface FileMessageContentProps {
  message: StoredMessage;
  transfer: TransferProgress | undefined;
  onOpen: () => void;
  onStop: () => void;
  canStop: boolean;
}

export function FileMessageContent({
  message,
  transfer,
  onOpen,
  onStop,
  canStop,
}: FileMessageContentProps) {
  const { t } = useTranslation();
  const file = message.file;
  const resourceUrl = useResourceObjectUrl(file);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => setPreviewFailed(false), [resourceUrl]);
  const progressText = transfer
    ? t("fileProgress", {
        size: formatBytes(file?.size || 0),
        percent:
          transfer.total === 0
            ? 0
            : Math.round(
                (transfer.transferred / transfer.total) * 100,
              ),
      })
    : formatBytes(file?.size || 0);
  const wrapFileContent = (content: ReactNode) => (
    <div className={styles.fileTransferContent}>
      {content}
      {message.status === "sending" && (
        <button
          type="button"
          className={styles.fileStopButton}
          disabled={!canStop}
          title={t("message.stopTransfer")}
          onClick={onStop}
        >
          <StopCircle size={16} weight="fill" />
          {t("message.stopTransfer")}
        </button>
      )}
      {transfer && (
        <span
          className={styles.progressBar}
          style={{
            transform: `scaleX(${
              transfer.total
                ? transfer.transferred / transfer.total
                : 0
            })`,
          }}
        />
      )}
    </div>
  );

  if (file && resourceUrl && !previewFailed && isImageFile(file)) {
    return wrapFileContent(
      <button
        type="button"
        className={styles.inlineMedia}
        onClick={onOpen}
        title={t("resources.preview")}
        aria-label={t("resources.preview")}
      >
        <img
          src={resourceUrl}
          alt={file.name}
          loading="lazy"
          onError={() => setPreviewFailed(true)}
        />
        <span className={styles.inlineMediaCaption}>
          <strong>{file.name}</strong>
          <small>{progressText}</small>
        </span>
      </button>
    );
  }

  if (file && resourceUrl && !previewFailed && isVideoFile(file)) {
    return wrapFileContent(
      <div className={styles.inlineMedia}>
        <video
          src={resourceUrl}
          controls
          playsInline
          preload="metadata"
          onError={() => setPreviewFailed(true)}
        />
        <button
          type="button"
          className={styles.inlineMediaCaption}
          onClick={onOpen}
          title={t("resources.preview")}
          aria-label={t("resources.preview")}
        >
          <strong>{file.name}</strong>
          <small>{progressText}</small>
        </button>
      </div>
    );
  }

  return wrapFileContent(
    <button
      type="button"
      className={styles.fileCard}
      onClick={onOpen}
      disabled={!file?.handleKey && !file?.resourceKey}
    >
      <span className={styles.fileIcon}>
        <FileIcon size={21} weight="duotone" />
      </span>
      <span>
        <strong>{file?.name}</strong>
        <small>{progressText}</small>
      </span>
    </button>
  );
}
