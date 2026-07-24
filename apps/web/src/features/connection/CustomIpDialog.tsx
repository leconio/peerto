import { Network, X } from "@phosphor-icons/react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import type { KnownPeer } from "../../store";

export interface CustomIpDialogProps {
  peer: KnownPeer;
  value: string;
  error: string | undefined;
  onValueChange: (value: string) => void;
  onSave: (event: FormEvent) => void;
  onClear: () => void;
  onClose: () => void;
}

export function CustomIpDialog({
  peer,
  value,
  error,
  onValueChange,
  onSave,
  onClear,
  onClose,
}: CustomIpDialogProps) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className={`${styles.modal} ${styles.customIpDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-ip-title"
        onSubmit={onSave}
      >
        <header>
          <h2 id="custom-ip-title">
            {t("customIp.title", { name: peer.name })}
          </h2>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("action.close")}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className={styles.customIpIntro}>
          <span aria-hidden="true">
            <Network size={22} />
          </span>
          <p>{t("customIp.description")}</p>
        </div>
        <label className={styles.customIpField}>
          <span>{t("customIp.label")}</span>
          <input
            value={value}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "custom-ip-error" : "custom-ip-help"}
            onChange={(event) => onValueChange(event.target.value)}
          />
        </label>
        {error ? (
          <p
            id="custom-ip-error"
            className={styles.customIpError}
            role="alert"
          >
            {error}
          </p>
        ) : (
          <p id="custom-ip-help" className={styles.customIpHelp}>
            {t("customIp.help")}
          </p>
        )}
        <div className={styles.customIpActions}>
          {peer.customIp ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClear}
            >
              {t("customIp.clear")}
            </button>
          ) : (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClose}
            >
              {t("action.cancel")}
            </button>
          )}
          <button type="submit" className={styles.primaryButton}>
            {t("customIp.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
