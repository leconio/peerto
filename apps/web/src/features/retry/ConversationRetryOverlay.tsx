import {
  ArrowClockwise,
  Network,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import type { ConnectionStatus } from "../../services/peer";
import type { ConversationRetryState } from "../../services/conversation-retry";

export interface ConversationRetryOverlayProps {
  retry: ConversationRetryState;
  peerName: string | undefined;
  status: ConnectionStatus;
  secondsRemaining: number;
  customIp: boolean;
  onRetryNow: () => void;
  onCancel: () => void;
  onEditCustomIp: () => void;
}

export function ConversationRetryOverlay({
  retry,
  peerName,
  status,
  secondsRemaining,
  customIp,
  onRetryNow,
  onCancel,
  onEditCustomIp,
}: ConversationRetryOverlayProps) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.retryBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="conversation-retry-title"
      aria-describedby="conversation-retry-status"
    >
      <div className={styles.retryPanel}>
        <span className={styles.retryIcon} aria-hidden="true">
          <ArrowClockwise
            size={30}
            className={
              retry.phase === "attempting"
                ? styles.refreshingIcon
                : undefined
            }
          />
        </span>
        <h2 id="conversation-retry-title">
          {t("retry.title", {
            name: peerName || t("device"),
          })}
        </h2>
        <strong>
          {t("retry.attempt", {
            count: retry.attempt,
          })}
        </strong>
        <p id="conversation-retry-status" aria-live="polite">
          {retry.phase === "attempting"
            ? t(
                customIp
                  ? "retry.customIpConnecting"
                  : "retry.connecting",
              )
            : retry.phase === "registered"
              ? t("retry.registered")
              : status === "network_offline"
                ? t("retry.networkOffline")
                : t(
                    customIp
                      ? "retry.customIpWaiting"
                      : "retry.waiting",
                    {
                      seconds: secondsRemaining,
                      next: retry.attempt + 1,
                    },
                  )}
        </p>
        <div
          className={`${styles.retryActions} ${
            customIp ? styles.retryActionsThree : ""
          }`}
        >
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onRetryNow}
          >
            <ArrowClockwise size={18} />
            {t("retry.retryNow")}
          </button>
          {customIp && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onEditCustomIp}
            >
              <Network size={18} />
              {t("customIp.editShort")}
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCancel}
          >
            {t("retry.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
