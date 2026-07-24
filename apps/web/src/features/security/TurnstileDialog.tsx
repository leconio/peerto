import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import styles from "../../styles/ui.module.css";

const SCRIPT_ID = "peerto-turnstile-script";
const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  const loading = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null;
    const script = existing || document.createElement("script");
    const handleLoad = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("TURNSTILE_UNAVAILABLE"));
    };
    const handleError = () => reject(new Error("TURNSTILE_UNAVAILABLE"));
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error) => {
    scriptPromise = undefined;
    throw error;
  });
  scriptPromise = loading;
  return loading;
}

export interface TurnstileDialogProps {
  siteKey: string;
  onToken: (token: string) => void;
  onCancel: () => void;
  onError: () => void;
}

export function TurnstileDialog({
  siteKey,
  onToken,
  onCancel,
  onError,
}: TurnstileDialogProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;
    void loadTurnstile()
      .then((turnstile) => {
        if (!active || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: "create_room",
          theme: "auto",
          size: "flexible",
          callback: onToken,
          "error-callback": onError,
          "expired-callback": onError,
        });
      })
      .catch(() => {
        if (active) onError();
      });

    return () => {
      active = false;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [onError, onToken, siteKey]);

  return (
    <Modal title={t("security.verificationTitle")} onClose={onCancel}>
      <p className={styles.helpText}>
        {t("security.verificationText")}
      </p>
      <div
        ref={containerRef}
        className={styles.turnstileContainer}
        aria-label={t("security.verificationTitle")}
      />
    </Modal>
  );
}
