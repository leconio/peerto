import { File as FileIcon, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import { formatBytes } from "../../lib/format";
import styles from "../../styles/ui.module.css";
import type { PendingAttachment } from "./clipboard";

function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();
  // Raster images only; do not render untrusted HTML/SVG or preload large video.
  const previewable = /^image\/(png|jpeg|webp|gif|avif)$/.test(file.type);
  useEffect(() => {
    if (!previewable) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, previewable]);
  return url ? <img src={url} alt="" /> : <FileIcon size={30} aria-hidden="true" />;
}

export function AttachmentDialog({ attachments, sending, canSend, recipient, onConfirm, onCancel, onRemove }: {
  attachments: PendingAttachment[];
  sending: boolean;
  canSend: boolean;
  recipient: string;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!attachments.length) return null;
  return <Modal title={t("attachments.title", { count: attachments.length })} onClose={onCancel} closeDisabled={sending}>
    <p className={styles.modalHelp}>{t("attachments.confirm", { name: recipient })}</p>
    <ul className={styles.attachmentList}>
      {attachments.map(({ id, file }) => <li key={id}>
        <span className={styles.attachmentPreview}><AttachmentPreview file={file} /></span>
        <span className={styles.attachmentCopy}><strong>{file.name || t("attachments.unnamed")}</strong><small>{formatBytes(file.size)} · {file.type || "application/octet-stream"}</small></span>
        <button className={styles.iconButton} type="button" disabled={sending} onClick={() => onRemove(id)} aria-label={t("attachments.remove", { name: file.name })}><X size={18} /></button>
      </li>)}
    </ul>
    <p className={styles.modalHelp}>{canSend ? t("attachments.queueHint") : t("error.DEVICE_OFFLINE")}</p>
    <div className={styles.modalActions}>
      <button type="button" autoFocus className={styles.secondaryButton} disabled={sending} onClick={onCancel}>{t("action.cancel")}</button>
      <button type="button" className={styles.primaryButton} disabled={sending || !canSend} onClick={onConfirm}>{t(sending ? "attachments.preparing" : "attachments.send", { count: attachments.length })}</button>
    </div>
  </Modal>;
}
