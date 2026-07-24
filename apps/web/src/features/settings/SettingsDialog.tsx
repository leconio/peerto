import {
  DownloadSimple,
  GearSix,
  Moon,
  Palette,
  PlugsConnected,
  ShieldCheck,
  SquaresFour,
  Sun,
  Translate,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "../../styles/ui.module.css";
import { Modal } from "../../components/Modal";
import type { AppLanguage } from "../../i18n";
import { formatBytes } from "../../lib/format";
import {
  type IceServerSettings,
  normalizeIceServerSettings,
  validateIceServerSettings,
} from "../../lib/ice-settings";
import {
  MAX_MAX_ACTIVE_PEER_CLIENTS,
  MIN_MAX_ACTIVE_PEER_CLIENTS,
  normalizeMaxActivePeerClients,
} from "../../lib/peer-client-settings";
import type { StoredMessage } from "../../store";
import { ResourceGridVisual } from "../resources/ResourceGridVisual";

type Theme = "light" | "dark" | "system";

export interface SettingsDialogProps {
  initialName: string;
  theme: Theme;
  language: AppLanguage;
  deviceId: string | undefined;
  iceSettings: IceServerSettings;
  maxActivePeerClients: number;
  resources: StoredMessage[];
  onPreviewResource: (message: StoredMessage) => void;
  onDownloadResource: (message: StoredMessage) => void;
  onDeleteResource: (message: StoredMessage) => void;
  onClearResources: () => void;
  onSave: (
    name: string,
    theme: Theme,
    language: AppLanguage,
    iceSettings: IceServerSettings,
    maxActivePeerClients: number,
  ) => void;
  onClose: () => void;
}

export function SettingsDialog({
  initialName,
  theme,
  language,
  deviceId,
  iceSettings,
  maxActivePeerClients,
  resources,
  onPreviewResource,
  onDownloadResource,
  onDeleteResource,
  onClearResources,
  onSave,
  onClose,
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<
    "general" | "appearance" | "connection" | "resources"
  >("general");
  const [name, setName] = useState(initialName);
  const [nextTheme, setNextTheme] = useState(theme);
  const [nextLanguage, setNextLanguage] = useState(language);
  const [stunUrls, setStunUrls] = useState(
    iceSettings.stunUrls.join("\n"),
  );
  const [turnUrls, setTurnUrls] = useState(iceSettings.turn.url);
  const [turnUsername, setTurnUsername] = useState(
    iceSettings.turn.username,
  );
  const [turnCredential, setTurnCredential] = useState(
    iceSettings.turn.credential,
  );
  const [relayOnly, setRelayOnly] = useState(
    Boolean(iceSettings.relayOnly),
  );
  const [maxActivePeerClientsDraft, setMaxActivePeerClientsDraft] =
    useState(String(maxActivePeerClients));
  const [validationError, setValidationError] = useState<string>();

  const save = () => {
    const nextIceSettings = normalizeIceServerSettings({
      stunUrls: stunUrls.split(/\r?\n/),
      turn: {
        url: turnUrls,
        username: turnUsername,
        credential: turnCredential,
      },
      relayOnly,
    });
    const error = validateIceServerSettings(nextIceSettings);
    if (error) {
      setSection("connection");
      setValidationError(`settings.iceError.${error}`);
      return;
    }
    onSave(
      name,
      nextTheme,
      nextLanguage,
      nextIceSettings,
      normalizeMaxActivePeerClients(
        Number(maxActivePeerClientsDraft),
      ),
    );
  };

  const sections = [
    {
      id: "general" as const,
      label: t("settings.general"),
      icon: <UserCircle size={19} />,
    },
    {
      id: "appearance" as const,
      label: t("settings.appearance"),
      icon: <Palette size={19} />,
    },
    {
      id: "connection" as const,
      label: t("settings.connection"),
      icon: <PlugsConnected size={19} />,
    },
    {
      id: "resources" as const,
      label: t("resources.title"),
      icon: <SquaresFour size={19} />,
    },
  ];

  return (
    <Modal title={t("settings.title")} onClose={onClose} wide>
      <div className={styles.settingsLayout}>
        <nav
          className={styles.settingsNav}
          aria-label={t("settings.categories")}
        >
          {sections.map((item) => (
            <button
              type="button"
              key={item.id}
              className={
                section === item.id ? styles.settingsNavActive : ""
              }
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <form
          className={styles.settingsPanel}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className={styles.settingsContent}>
            {section === "general" && (
              <section className={styles.settingsSection}>
                <div className={styles.settingsHeading}>
                  <h3>{t("settings.general")}</h3>
                  <p>{t("settings.generalHint")}</p>
                </div>
                <label
                  className={styles.settingsField}
                  htmlFor="device-name"
                >
                  <span>{t("settings.deviceName")}</span>
                  <input
                    id="device-name"
                    maxLength={64}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <div className={styles.identityInfo}>
                  <ShieldCheck size={20} />
                  <span>
                    <strong>{t("settings.identity")}</strong>
                    <small>
                      {deviceId
                        ? t("settings.identityHint", {
                            id: deviceId.slice(0, 7).toUpperCase(),
                          })
                        : t("settings.generating")}
                    </small>
                  </span>
                </div>
              </section>
            )}

            {section === "appearance" && (
              <section className={styles.settingsSection}>
                <div className={styles.settingsHeading}>
                  <h3>{t("settings.appearance")}</h3>
                  <p>{t("settings.appearanceHint")}</p>
                </div>
                <fieldset>
                  <legend>{t("settings.theme")}</legend>
                  <div className={styles.themeOptions}>
                    {(
                      [
                        [
                          "system",
                          t("settings.system"),
                          <GearSix size={18} key="system" />,
                        ],
                        [
                          "light",
                          t("settings.light"),
                          <Sun size={18} key="light" />,
                        ],
                        [
                          "dark",
                          t("settings.dark"),
                          <Moon size={18} key="dark" />,
                        ],
                      ] as const
                    ).map(([value, label, icon]) => (
                      <button
                        type="button"
                        key={value}
                        className={
                          nextTheme === value
                            ? styles.themeOptionActive
                            : ""
                        }
                        onClick={() => setNextTheme(value)}
                      >
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{t("settings.language")}</legend>
                  <div className={styles.languageOptions}>
                    {(
                      [
                        ["zh", t("settings.chinese")],
                        ["en", t("settings.english")],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={
                          nextLanguage === value
                            ? styles.themeOptionActive
                            : ""
                        }
                        onClick={() => setNextLanguage(value)}
                      >
                        <Translate size={18} />
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </section>
            )}

            {section === "connection" && (
              <section className={styles.settingsSection}>
                <div className={styles.settingsHeading}>
                  <h3>{t("settings.connection")}</h3>
                  <p>{t("settings.connectionHint")}</p>
                </div>
                <label
                  className={styles.settingsField}
                  htmlFor="max-active-peer-clients"
                >
                  <span>{t("settings.maxActivePeerClients")}</span>
                  <input
                    id="max-active-peer-clients"
                    type="number"
                    inputMode="numeric"
                    min={MIN_MAX_ACTIVE_PEER_CLIENTS}
                    max={MAX_MAX_ACTIVE_PEER_CLIENTS}
                    step={1}
                    value={maxActivePeerClientsDraft}
                    onChange={(event) =>
                      setMaxActivePeerClientsDraft(event.target.value)
                    }
                  />
                  <small>
                    {t("settings.maxActivePeerClientsHint", {
                      min: MIN_MAX_ACTIVE_PEER_CLIENTS,
                      max: MAX_MAX_ACTIVE_PEER_CLIENTS,
                    })}
                  </small>
                </label>

                <div className={styles.settingsDivider} />

                <label
                  className={styles.settingsField}
                  htmlFor="stun-urls"
                >
                  <span>STUN</span>
                  <textarea
                    id="stun-urls"
                    rows={6}
                    value={stunUrls}
                    spellCheck={false}
                    placeholder="stun:stun.example.com:3478"
                    onChange={(event) => {
                      setStunUrls(event.target.value);
                      setValidationError(undefined);
                    }}
                  />
                  <small>{t("settings.stunHint")}</small>
                </label>

                <div className={styles.settingsDivider} />

                <div className={styles.turnHeading}>
                  <strong>TURN</strong>
                  <span>{t("settings.optional")}</span>
                </div>
                <label className={styles.relayOnlyOption}>
                  <input
                    type="checkbox"
                    checked={relayOnly}
                    disabled={!turnUrls.trim() && !relayOnly}
                    onChange={(event) =>
                      setRelayOnly(event.target.checked)
                    }
                  />
                  <span>
                    <strong>{t("settings.relayOnly")}</strong>
                    <small>{t("settings.relayOnlyHint")}</small>
                  </span>
                </label>
                <div className={styles.turnFields}>
                  <label
                    className={styles.settingsField}
                    htmlFor="turn-urls"
                  >
                    <span>{t("settings.turnUrls")}</span>
                    <textarea
                      id="turn-urls"
                      rows={4}
                      value={turnUrls}
                      spellCheck={false}
                      placeholder="turn:turn.example.com:3478"
                      onChange={(event) => {
                        setTurnUrls(event.target.value);
                        if (!event.target.value.trim()) {
                          setRelayOnly(false);
                        }
                        setValidationError(undefined);
                      }}
                    />
                    <small>{t("settings.turnUrlsHint")}</small>
                  </label>
                  <label
                    className={styles.settingsField}
                    htmlFor="turn-username"
                  >
                    <span>{t("settings.turnUsername")}</span>
                    <input
                      id="turn-username"
                      value={turnUsername}
                      autoComplete="username"
                      onChange={(event) =>
                        setTurnUsername(event.target.value)
                      }
                    />
                  </label>
                  <label
                    className={styles.settingsField}
                    htmlFor="turn-credential"
                  >
                    <span>{t("settings.turnCredential")}</span>
                    <input
                      id="turn-credential"
                      type="password"
                      value={turnCredential}
                      autoComplete="new-password"
                      onChange={(event) =>
                        setTurnCredential(event.target.value)
                      }
                    />
                  </label>
                </div>
                <p className={styles.settingsNote}>
                  {t("settings.turnStorageHint")}
                </p>
                {validationError && (
                  <p className={styles.settingsError} role="alert">
                    {t(validationError)}
                  </p>
                )}
              </section>
            )}

            {section === "resources" && (
              <section className={styles.settingsSection}>
                <div className={styles.resourceSectionHeading}>
                  <div className={styles.settingsHeading}>
                    <h3>{t("resources.title")}</h3>
                    <p>
                      {t("resources.hint", {
                        count: resources.length,
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={resources.length === 0}
                    onClick={() => {
                      if (window.confirm(t("resources.clearConfirm"))) {
                        onClearResources();
                      }
                    }}
                  >
                    <Trash size={17} />
                    {t("resources.clearAll")}
                  </button>
                </div>

                {resources.length === 0 ? (
                  <div className={styles.resourceEmpty}>
                    <SquaresFour size={34} weight="duotone" />
                    <strong>{t("resources.empty")}</strong>
                    <p>{t("resources.emptyHint")}</p>
                  </div>
                ) : (
                  <div className={styles.resourceGrid}>
                    {resources.map((message) => (
                      <article
                        key={message.id}
                        className={styles.resourceCard}
                      >
                        <button
                          type="button"
                          className={styles.resourcePreviewButton}
                          title={t("resources.preview")}
                          aria-label={t("resources.preview")}
                          onClick={() => onPreviewResource(message)}
                        >
                          <span className={styles.resourceVisual}>
                            <ResourceGridVisual message={message} />
                          </span>
                          <span className={styles.resourceCardCopy}>
                            <strong>{message.file?.name}</strong>
                            <small>
                              {formatBytes(message.file?.size || 0)}
                            </small>
                          </span>
                        </button>
                        <div className={styles.resourceActions}>
                          <button
                            type="button"
                            title={t("resources.download")}
                            aria-label={t("resources.download")}
                            onClick={() => onDownloadResource(message)}
                          >
                            <DownloadSimple size={17} />
                          </button>
                          <button
                            type="button"
                            title={t("resources.delete")}
                            aria-label={t("resources.delete")}
                            onClick={() => onDeleteResource(message)}
                          >
                            <Trash size={17} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>

          {section !== "resources" && (
            <footer className={styles.settingsFooter}>
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={!name.trim()}
              >
                {t("action.saveSettings")}
              </button>
            </footer>
          )}
        </form>
      </div>
    </Modal>
  );
}
