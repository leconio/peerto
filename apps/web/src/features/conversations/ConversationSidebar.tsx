import {
  ArrowClockwise,
  GearSix,
  LinkSimple,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { deviceAvatarLabel } from "../../lib/device-name";
import styles from "../../styles/ui.module.css";
import type {
  ConnectionStatus,
  IceAddressSnapshot,
} from "../../services/peer";
import { networkEnvironmentState } from "../connection/network-environment";
import {
  SAVED_CONVERSATION_ID,
  type KnownPeer,
} from "../../store";

export interface ConversationSidebarProps {
  hiddenOnMobile: boolean;
  peers: KnownPeer[];
  selectedId: string;
  onlinePeerIds: ReadonlySet<string>;
  status: ConnectionStatus;
  ipProbing: boolean;
  iceSnapshot: IceAddressSnapshot | undefined;
  connectionActionsDisabled: boolean;
  refreshIpDisabled: boolean;
  onRefreshIp: () => void;
  onOpenSettings: () => void;
  onSelectConversation: (id: string) => void;
  onCreateRoom: () => void;
  onOpenJoin: () => void;
}

export function ConversationSidebar({
  hiddenOnMobile,
  peers,
  selectedId,
  onlinePeerIds,
  status,
  ipProbing,
  iceSnapshot,
  connectionActionsDisabled,
  refreshIpDisabled,
  onRefreshIp,
  onOpenSettings,
  onSelectConversation,
  onCreateRoom,
  onOpenJoin,
}: ConversationSidebarProps) {
  const { t } = useTranslation();
  const environmentState = networkEnvironmentState(
    iceSnapshot,
    ipProbing,
    status !== "network_offline",
  );
  return (
    <aside
      className={`${styles.sidebar} ${
        hiddenOnMobile ? styles.sidebarHiddenMobile : ""
      }`}
    >
      <div className={styles.brandRow}>
        <img
          className={styles.brandMark}
          src="/peerto-icon.svg"
          alt=""
          width="38"
          height="38"
        />
        <div className={styles.brandCopy}>
          <div className={styles.brandName}>{t("appName")}</div>
          <div
            className={styles.networkStatus}
            data-state={environmentState}
          >
            <span className={styles.networkStatusDot} aria-hidden="true" />
            <span className={styles.networkStatusText}>
              {t(`networkEnvironment.${environmentState}`)}
            </span>
            <button
              className={styles.networkRefreshButton}
              type="button"
              title={t("action.refreshIp")}
              aria-label={t("action.refreshIp")}
              disabled={refreshIpDisabled}
              onClick={onRefreshIp}
            >
              <ArrowClockwise
                size={14}
                className={
                  ipProbing ? styles.refreshingIcon : undefined
                }
              />
            </button>
          </div>
        </div>
        <div className={styles.brandActions}>
          <button
            className={styles.iconButton}
            type="button"
            title={t("action.settings")}
            aria-label={t("action.openSettings")}
            onClick={onOpenSettings}
          >
            <GearSix size={20} />
          </button>
        </div>
      </div>

      <nav
        className={styles.conversationList}
        aria-label={t("conversationList")}
      >
        <button
          type="button"
          className={`${styles.conversationItem} ${
            selectedId === SAVED_CONVERSATION_ID
              ? styles.conversationItemActive
              : ""
          }`}
          onClick={() => onSelectConversation(SAVED_CONVERSATION_ID)}
        >
          <span className={`${styles.avatar} ${styles.savedAvatar}`}>
            <ShieldCheck size={22} weight="fill" />
          </span>
          <span className={styles.conversationCopy}>
            <strong>{t("savedMessages")}</strong>
            <small>{t("localOnly")}</small>
          </span>
        </button>

        <div className={styles.sectionLabel}>
          <span>{t("connectedDevices")}</span>
          <span>{peers.length}</span>
        </div>

        {peers.length === 0 ? (
          <div className={styles.emptyDevices}>
            {t("noDevices")}
            <small>{t("noDevicesHint")}</small>
          </div>
        ) : (
          peers.map((peer) => {
            const peerOnline = onlinePeerIds.has(peer.deviceId);
            return (
              <button
                type="button"
                key={peer.deviceId}
                className={`${styles.conversationItem} ${
                  selectedId === peer.deviceId
                    ? styles.conversationItemActive
                    : ""
                }`}
                onClick={() => onSelectConversation(peer.deviceId)}
              >
                <span className={styles.avatar}>
                  {deviceAvatarLabel(peer.name, peer.deviceId)}
                  <span
                    className={`${styles.presenceDot} ${
                      peerOnline ? styles.presenceOnline : ""
                    }`}
                  />
                </span>
                <span className={styles.conversationCopy}>
                  <strong>{peer.name}</strong>
                  <small>
                    {t(`status.${peerOnline ? "online" : "offline"}`)}
                  </small>
                </span>
              </button>
            );
          })
        )}
      </nav>

      <div className={styles.sidebarActions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onCreateRoom}
          disabled={connectionActionsDisabled}
        >
          <Plus size={18} weight="bold" />
          {t("action.generateCode")}
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onOpenJoin}
          disabled={connectionActionsDisabled}
        >
          <LinkSimple size={18} />
          {t("action.enterCode")}
        </button>
      </div>
    </aside>
  );
}
