import {
  Cookie,
  IdentificationCard,
  ShieldCheck,
} from "@phosphor-icons/react";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { registerSW } from "virtual:pwa-register";
import {
  needsFirstDeviceName,
  normalizedDeviceName,
  saveFirstDeviceName,
} from "../../lib/first-use";
import {
  hasStorageConsent,
  storageConsentCookie,
} from "../../lib/storage-consent";
import styles from "../../styles/ui.module.css";

const PeertoApp = lazy(async () => {
  await import("../../i18n");
  const { App } = await import("../../App");
  return { default: App };
});

type BootstrapStage = "consent" | "declined" | "name" | "ready";
let serviceWorkerRegistrationStarted = false;

const copy = {
  zh: {
    consentEyebrow: "开始前",
    consentTitle: "授权本机存储",
    consentText:
      "Peerto 需要使用一个授权 Cookie，以及浏览器本地存储来保存设备身份、名称、连接记录和消息。不同意授权将无法使用 Peerto。",
    consentPrivacy: "这些数据不会用于广告或跨站跟踪。",
    privacyLink: "查看隐私说明",
    accept: "同意并继续",
    decline: "不同意",
    declinedTitle: "Peerto 当前不可用",
    declinedText:
      "未获得 Cookie 与本机存储授权，设备身份和会话无法安全保存。你可以重新查看并授权。",
    review: "重新查看授权",
    nameEyebrow: "本机身份",
    nameTitle: "给这台设备起个名字",
    nameText: "对方连接后会看到这个名称，之后可在设置中修改。",
    nameLabel: "本机名称",
    namePlaceholder: "例如：小明的 Mac",
    nameRequired: "请输入本机名称",
    enter: "进入 Peerto",
    loading: "正在加载 Peerto",
  },
  en: {
    consentEyebrow: "Before you start",
    consentTitle: "Allow local storage",
    consentText:
      "Peerto needs one consent cookie and browser-local storage to keep your device identity, name, connections, and messages. Peerto cannot be used without this authorization.",
    consentPrivacy: "This data is not used for ads or cross-site tracking.",
    privacyLink: "Read the privacy notice",
    accept: "Allow and continue",
    decline: "Decline",
    declinedTitle: "Peerto is unavailable",
    declinedText:
      "Without cookie and local-storage authorization, Peerto cannot safely keep a device identity or sessions. You can review the request again.",
    review: "Review authorization",
    nameEyebrow: "Local identity",
    nameTitle: "Name this device",
    nameText:
      "Other devices will see this name after connecting. You can change it later in Settings.",
    nameLabel: "Device name",
    namePlaceholder: "For example: Alice's Mac",
    nameRequired: "Enter a name for this device",
    enter: "Open Peerto",
    loading: "Loading Peerto",
  },
} as const;

function stageAfterConsent(): BootstrapStage {
  return needsFirstDeviceName(localStorage) ? "name" : "ready";
}

function initialStage(): BootstrapStage {
  return hasStorageConsent(document.cookie)
    ? stageAfterConsent()
    : "consent";
}

export function AppBootstrap() {
  const language = navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  const t = copy[language];
  const [stage, setStage] = useState<BootstrapStage>(initialStage);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (stage !== "ready" || serviceWorkerRegistrationStarted) return;
    serviceWorkerRegistrationStarted = true;
    registerSW({ immediate: true });
  }, [stage]);

  const acceptStorage = () => {
    document.cookie = storageConsentCookie(
      window.location.protocol === "https:",
    );
    if (!hasStorageConsent(document.cookie)) {
      setStage("declined");
      return;
    }
    setStage(stageAfterConsent());
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizedDeviceName(name);
    if (!normalized) {
      setError(t.nameRequired);
      return;
    }
    if (!saveFirstDeviceName(localStorage, normalized)) {
      setError(t.declinedText);
      return;
    }
    setStage("ready");
  };

  if (stage === "ready") {
    return (
      <Suspense
        fallback={
          <div className={styles.bootstrapLoading} role="status">
            {t.loading}
          </div>
        }
      >
        <PeertoApp />
      </Suspense>
    );
  }

  return (
    <main className={styles.bootstrapShell}>
      <section
        className={styles.bootstrapCard}
        aria-labelledby="bootstrap-title"
      >
        <img
          className={styles.bootstrapBrand}
          src="/peerto-icon.svg"
          alt=""
          width="44"
          height="44"
        />

        {stage === "consent" && (
          <>
            <span className={styles.bootstrapIcon} aria-hidden="true">
              <Cookie size={22} weight="fill" />
            </span>
            <p className={styles.bootstrapEyebrow}>
              {t.consentEyebrow}
            </p>
            <h1 id="bootstrap-title">{t.consentTitle}</h1>
            <p>{t.consentText}</p>
            <p className={styles.bootstrapFinePrint}>
              <ShieldCheck size={16} weight="fill" aria-hidden="true" />
              <span>
                {t.consentPrivacy}{" "}
                <a
                  href={`https://github.com/leconio/peerto/blob/main/docs/privacy${
                    language === "zh" ? ".zh-CN" : ""
                  }.md`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.privacyLink}
                </a>
              </span>
            </p>
            <div className={styles.bootstrapActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={acceptStorage}
              >
                {t.accept}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setStage("declined")}
              >
                {t.decline}
              </button>
            </div>
          </>
        )}

        {stage === "declined" && (
          <>
            <span className={styles.bootstrapIcon} aria-hidden="true">
              <ShieldCheck size={22} />
            </span>
            <p className={styles.bootstrapEyebrow}>
              {t.consentEyebrow}
            </p>
            <h1 id="bootstrap-title">{t.declinedTitle}</h1>
            <p>{t.declinedText}</p>
            <div className={styles.bootstrapActionsSingle}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setStage("consent")}
              >
                {t.review}
              </button>
            </div>
          </>
        )}

        {stage === "name" && (
          <form onSubmit={submitName}>
            <span className={styles.bootstrapIcon} aria-hidden="true">
              <IdentificationCard size={22} weight="fill" />
            </span>
            <p className={styles.bootstrapEyebrow}>{t.nameEyebrow}</p>
            <h1 id="bootstrap-title">{t.nameTitle}</h1>
            <p>{t.nameText}</p>
            <label className={styles.bootstrapField}>
              <span>{t.nameLabel}</span>
              <input
                autoFocus
                value={name}
                maxLength={64}
                autoComplete="off"
                placeholder={t.namePlaceholder}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "device-name-error" : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(undefined);
                }}
              />
            </label>
            {error && (
              <p id="device-name-error" className={styles.bootstrapError}>
                {error}
              </p>
            )}
            <div className={styles.bootstrapActionsSingle}>
              <button type="submit" className={styles.primaryButton}>
                {t.enter}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
