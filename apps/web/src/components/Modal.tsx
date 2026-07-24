import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "../styles/ui.module.css";

export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  wide?: boolean;
}

export function Modal({
  title,
  children,
  onClose,
  closeDisabled = false,
  wide = false,
}: ModalProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section
        className={`${styles.modal} ${wide ? styles.modalWide : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("action.close")}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
