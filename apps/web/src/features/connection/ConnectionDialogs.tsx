import {
  Check,
  CircleNotch,
  Clipboard,
  ClockCountdown,
  LinkSimple,
  ShareNetwork,
  Trash,
} from "@phosphor-icons/react";
import type { DeviceIdentity } from "@peerto/protocol";
import type { FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import { Modal } from "../../components/Modal";
import type {
  ConnectionStatus,
  RoomInfo,
} from "../../services/peer";
import type { KnownPeer } from "../../store";
import { shareUrl } from "./share-link";

export type ConnectionDialogKind = "host" | "join" | "auto" | null;

export interface ConnectionDialogsProps {
  dialog: ConnectionDialogKind;
  room: RoomInfo | undefined;
  status: ConnectionStatus;
  secondsRemaining: number;
  copied: "code" | "link" | undefined;
  joinCode: string;
  joinRequest: DeviceIdentity | undefined;
  deleteConfirmation: KnownPeer | undefined;
  deletePeerOnline: boolean;
  deleteForPeer: boolean;
  deletePending: boolean;
  onCloseHost: () => void;
  onCopyCode: () => void;
  onShareRoom: () => void;
  onCopyShareLink: () => void;
  onCloseJoin: () => void;
  onJoinCodeChange: (code: string) => void;
  onJoinSubmit: (event: FormEvent) => void;
  onCloseAuto: () => void;
  onRejectPeer: (deviceId: string) => void;
  onAcceptPeer: (deviceId: string) => void;
  onCloseDelete: () => void;
  onDeleteForPeerChange: (enabled: boolean) => void;
  onConfirmDelete: () => void;
}

export function ConnectionDialogs({
  dialog,
  room,
  status,
  secondsRemaining,
  copied,
  joinCode,
  joinRequest,
  deleteConfirmation,
  deletePeerOnline,
  deleteForPeer,
  deletePending,
  onCloseHost,
  onCopyCode,
  onShareRoom,
  onCopyShareLink,
  onCloseJoin,
  onJoinCodeChange,
  onJoinSubmit,
  onCloseAuto,
  onRejectPeer,
  onAcceptPeer,
  onCloseDelete,
  onDeleteForPeerChange,
  onConfirmDelete,
}: ConnectionDialogsProps) {
  const { t } = useTranslation();
  return (
    <>
      {dialog === "host" && (
        <Modal title={t("hostDialog.title")} onClose={onCloseHost}>
          {room ? (
            <div className={styles.codePanel}>
              <div className={styles.codeLabel}>
                {status === "waiting"
                  ? t("hostDialog.codeActive")
                  : t(`status.${status}`)}
              </div>
              <button
                type="button"
                className={styles.roomCode}
                onClick={onCopyCode}
                aria-label={t("action.copyCode")}
              >
                {room.code.slice(0, 3)}
                <span />
                {room.code.slice(3)}
              </button>
              <div className={styles.expiry}>
                <ClockCountdown size={18} />
                {secondsRemaining > 0
                  ? t("hostDialog.expiresIn", {
                      time: `${Math.floor(secondsRemaining / 60)}:${String(
                        secondsRemaining % 60,
                      ).padStart(2, "0")}`,
                    })
                  : t("hostDialog.expired")}
              </div>
              {room.shareToken && secondsRemaining > 0 && status === "waiting" && (
                <div className={styles.roomQr}>
                  <QRCodeSVG value={shareUrl(room)} size={208} level="M" marginSize={4}
                    title={t("hostDialog.scanQr")} role="img" aria-label={t("hostDialog.scanQr")} />
                  <p>{t("hostDialog.scanHint")}</p>
                </div>
              )}
              {room.shareToken && (
                <div className={styles.shareActions}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={onShareRoom}
                  >
                    <ShareNetwork size={18} />
                    {t("action.shareLink")}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={onCopyShareLink}
                  >
                    {copied === "link" ? (
                      <Check size={18} weight="bold" />
                    ) : (
                      <LinkSimple size={18} />
                    )}
                    {copied === "link"
                      ? t("action.copied")
                      : t("action.copyLink")}
                  </button>
                </div>
              )}
              <button
                type="button"
                className={styles.codeCopyButton}
                onClick={onCopyCode}
              >
                {copied === "code" ? (
                  <Check size={18} weight="bold" />
                ) : (
                  <Clipboard size={18} />
                )}
                {copied === "code"
                  ? t("action.copied")
                  : t("action.copyCode")}
              </button>
              <p className={styles.modalHelp}>
                {t("hostDialog.help")}
              </p>
            </div>
          ) : (
            <div className={styles.loadingPanel}>
              <span className={styles.spinner} />
              {t("hostDialog.generating")}
            </div>
          )}
        </Modal>
      )}

      {dialog === "join" && (
        <Modal title={t("joinDialog.title")} onClose={onCloseJoin}>
          <form className={styles.joinForm} onSubmit={onJoinSubmit}>
            <label htmlFor="join-code">{t("joinDialog.label")}</label>
            <input
              id="join-code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={joinCode}
              placeholder="000000"
              onChange={(event) =>
                onJoinCodeChange(
                  event.target.value.replace(/\D/g, "").slice(0, 6),
                )
              }
            />
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={
                joinCode.length !== 6 ||
                status === "signaling" ||
                status === "authenticating"
              }
            >
              <LinkSimple size={18} />
              {status === "signaling" || status === "authenticating"
                ? t("joinDialog.connecting")
                : t("joinDialog.connect")}
            </button>
            <p className={styles.modalHelp}>{t("joinDialog.help")}</p>
          </form>
        </Modal>
      )}

      {dialog === "auto" && (
        <Modal title={t("joinDialog.autoTitle")} onClose={onCloseAuto}>
          <div className={styles.loadingPanel}>
            <span className={styles.spinner} />
            <strong>{t(`status.${status}`)}</strong>
            <p className={styles.modalHelp}>{t("joinDialog.autoText")}</p>
          </div>
        </Modal>
      )}

      {joinRequest && (
        <Modal
          title={t("approval.title")}
          onClose={() => onRejectPeer(joinRequest.deviceId)}
        >
          <div className={styles.deviceApproval}>
            <span className={styles.largeAvatar}>
              {initials(joinRequest.name)}
            </span>
            <strong>{joinRequest.name}</strong>
            <code>{shortId(joinRequest.deviceId)}</code>
            <p>{t("approval.text")}</p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => onRejectPeer(joinRequest.deviceId)}
              >
                {t("action.reject")}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => onAcceptPeer(joinRequest.deviceId)}
              >
                <Check size={18} weight="bold" />
                {t("action.allow")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirmation && (
        <Modal
          title={t("deleteConversation.title")}
          onClose={onCloseDelete}
          closeDisabled={deletePending}
        >
          <div className={styles.deleteConfirmation}>
            <span className={styles.deleteConfirmationIcon}>
              <Trash size={27} weight="fill" />
            </span>
            <strong>
              {t("deleteConversation.heading", {
                name: deleteConfirmation.name,
              })}
            </strong>
            <p aria-live="polite">
              {deletePending
                ? t("deleteConversation.waitingForPeer")
                : t(
                    deleteForPeer
                      ? "deleteConversation.textBoth"
                      : "deleteConversation.text",
                  )}
            </p>
            {(deletePeerOnline || deleteForPeer) && (
              <label className={styles.remoteDeleteOption}>
                <input
                  type="checkbox"
                  checked={deleteForPeer}
                  disabled={!deletePeerOnline || deletePending}
                  onChange={(event) =>
                    onDeleteForPeerChange(event.target.checked)
                  }
                />
                <span>
                  <strong>{t("deleteConversation.deleteForPeer")}</strong>
                  <small>
                    {deletePeerOnline
                      ? t("deleteConversation.deleteForPeerHint")
                      : t("deleteConversation.peerWentOffline")}
                  </small>
                </span>
              </label>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                autoFocus
                disabled={deletePending}
                onClick={onCloseDelete}
              >
                {t("action.cancel")}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                disabled={
                  deletePending ||
                  (deleteForPeer && !deletePeerOnline)
                }
                onClick={onConfirmDelete}
              >
                {deletePending ? (
                  <CircleNotch
                    size={18}
                    className={styles.refreshingIcon}
                  />
                ) : (
                  <Trash size={18} />
                )}
                {deletePending
                  ? t("deleteConversation.deleting")
                  : deleteForPeer
                    ? t("deleteConversation.confirmBoth")
                    : t("action.confirmDelete")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 7).toUpperCase();
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "P";
}
