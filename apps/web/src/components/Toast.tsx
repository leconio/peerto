import { useTranslation } from "react-i18next";
import styles from "../styles/ui.module.css";

export interface ToastNotice {
  key: string;
  values?: Record<string, string | number>;
}

export function Toast({ notice }: { notice: ToastNotice }) {
  const { t } = useTranslation();
  return (
    <div className={styles.toast} role="status">
      {t(notice.key, {
        ...notice.values,
        defaultValue: t("server.unknown"),
      })}
    </div>
  );
}
