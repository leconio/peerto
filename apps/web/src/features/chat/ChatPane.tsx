import {
  ArrowBendUpLeft,
  ArrowLeft,
  CheckCircle,
  DotsThreeVertical,
  LinkSimple,
  Network,
  PaperPlaneRight,
  Paperclip,
  ShieldCheck,
  Trash,
  X,
} from "@phosphor-icons/react";
import type {
  KeyboardEvent,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { deviceAvatarLabel } from "../../lib/device-name";
import styles from "../../styles/ui.module.css";
import {
  SAVED_CONVERSATION_ID,
  type KnownPeer,
  type StoredMessage,
} from "../../store";
import { MessageList } from "../messages/MessageList";
import { messagePreview } from "../messages/message-utils";
import type { MessageJumpTarget } from "../messages/types";
import type { TransferProgress } from "../transfers/types";

export interface ChatPaneProps {
  visibleOnMobile: boolean;
  selectedId: string;
  selectedPeer: KnownPeer | undefined;
  selectedMessages: StoredMessage[];
  ownDeviceId: string | undefined;
  onlineForSelection: boolean;
  connectionRouteSummary: string;
  peerMenuOpen: boolean;
  peerMenuRef: RefObject<HTMLDivElement | null>;
  activePinnedMessage: StoredMessage | undefined;
  pinnedMessages: StoredMessage[];
  pinnedCursor: number;
  progress: Record<string, TransferProgress>;
  messageJumpTarget: MessageJumpTarget | undefined;
  replyingTo: StoredMessage | undefined;
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onBack: () => void;
  onTogglePeerMenu: () => void;
  onConfigureCustomIp: () => void;
  onDeleteConversation: () => void;
  onOpenPinnedMessage: () => void;
  onTogglePin: (message: StoredMessage) => void;
  onDeleteMessage: (message: StoredMessage) => void;
  onOpenFile: (message: StoredMessage) => void;
  onStopFile: (message: StoredMessage) => void;
  onReply: (message: StoredMessage) => void;
  onJumpToMessage: (messageId: string) => void;
  onCancelReply: () => void;
  onSelectFile: () => void;
  onDraftChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}

export function ChatPane({
  visibleOnMobile,
  selectedId,
  selectedPeer,
  selectedMessages,
  ownDeviceId,
  onlineForSelection,
  connectionRouteSummary,
  peerMenuOpen,
  peerMenuRef,
  activePinnedMessage,
  pinnedMessages,
  pinnedCursor,
  progress,
  messageJumpTarget,
  replyingTo,
  draft,
  inputRef,
  onBack,
  onTogglePeerMenu,
  onConfigureCustomIp,
  onDeleteConversation,
  onOpenPinnedMessage,
  onTogglePin,
  onDeleteMessage,
  onOpenFile,
  onStopFile,
  onReply,
  onJumpToMessage,
  onCancelReply,
  onSelectFile,
  onDraftChange,
  onComposerKeyDown,
  onSend,
}: ChatPaneProps) {
  const { t } = useTranslation();
  const savedConversation = selectedId === SAVED_CONVERSATION_ID;

  return (
    <main
      className={`${styles.chatPane} ${
        visibleOnMobile ? styles.chatPaneVisibleMobile : ""
      }`}
    >
      <header className={styles.chatHeader}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.mobileBack}`}
          aria-label={t("conversationList")}
          onClick={onBack}
        >
          <ArrowLeft size={21} />
        </button>
        <span
          className={`${styles.avatar} ${
            savedConversation ? styles.savedAvatar : ""
          }`}
        >
          {savedConversation ? (
            <ShieldCheck size={22} weight="fill" />
          ) : (
            deviceAvatarLabel(
              selectedPeer?.name || "",
              selectedPeer?.deviceId || selectedId,
            )
          )}
        </span>
        <div className={styles.headerCopy}>
          <strong>
            {savedConversation
              ? t("savedMessages")
              : selectedPeer?.name || t("device")}
          </strong>
          <small>
            {savedConversation
              ? t("localMessageAndHandles")
              : onlineForSelection
                ? connectionRouteSummary
                : selectedPeer
                  ? t("offlineWithId", {
                      id: shortId(selectedPeer.deviceId),
                    })
                  : t("selectDevice")}
          </small>
        </div>
        {onlineForSelection && (
          <span className={styles.p2pBadge}>
            <CheckCircle size={16} weight="fill" />
            {t("status.online")}
          </span>
        )}
        {selectedPeer && (
          <div className={styles.peerMenu} ref={peerMenuRef}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("action.conversationMenu")}
              aria-haspopup="menu"
              aria-expanded={peerMenuOpen}
              onClick={onTogglePeerMenu}
            >
              <DotsThreeVertical size={21} weight="bold" />
            </button>
            {peerMenuOpen && (
              <div
                className={styles.peerMenuList}
                role="menu"
                aria-label={t("action.conversationMenu")}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={onConfigureCustomIp}
                >
                  <Network size={18} />
                  {selectedPeer.customIp
                    ? t("customIp.edit")
                    : t("customIp.configure")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.peerMenuDanger}
                  onClick={onDeleteConversation}
                >
                  <Trash size={18} />
                  {t("action.deleteConversation")}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <section className={styles.messageArea} aria-live="polite">
        {activePinnedMessage && (
          <div className={styles.pinnedBar}>
            <button
              type="button"
              className={styles.pinnedBarJump}
              onClick={onOpenPinnedMessage}
            >
              <span className={styles.pinnedBarMarker} aria-hidden="true">
                {pinnedMessages.slice(0, 3).map((message, index) => (
                  <span
                    key={message.id}
                    className={
                      index ===
                      pinnedCursor %
                        Math.min(pinnedMessages.length, 3)
                        ? styles.pinnedBarMarkerActive
                        : ""
                    }
                  />
                ))}
              </span>
              <span className={styles.pinnedBarCopy}>
                <strong>
                  {t("message.pinned", {
                    current:
                      (pinnedCursor % pinnedMessages.length) + 1,
                    total: pinnedMessages.length,
                  })}
                </strong>
                <small>{messagePreview(activePinnedMessage)}</small>
              </span>
            </button>
            <button
              type="button"
              className={styles.pinnedBarClose}
              title={t("message.unpin")}
              aria-label={t("message.unpin")}
              onClick={() => onTogglePin(activePinnedMessage)}
            >
              <X size={18} />
            </button>
          </div>
        )}
        {selectedMessages.length === 0 ? (
          <div className={styles.emptyChat}>
            <span className={styles.emptyChatIcon}>
              {savedConversation ? (
                <ShieldCheck size={30} weight="fill" />
              ) : (
                <LinkSimple size={30} />
              )}
            </span>
            <h1>
              {savedConversation
                ? t("ownLocalSpace")
                : t("startP2PChat")}
            </h1>
            <p>
              {savedConversation
                ? t("savedDescription")
                : onlineForSelection
                  ? t("onlineDescription")
                  : t("offlineDescription")}
            </p>
          </div>
        ) : (
          <MessageList
            key={selectedId}
            messages={selectedMessages}
            ownDeviceId={ownDeviceId}
            peerName={selectedPeer?.name}
            peerDeviceId={selectedPeer?.deviceId}
            progress={progress}
            canStopTransfer={onlineForSelection}
            onOpenFile={onOpenFile}
            onStopFile={onStopFile}
            onReply={onReply}
            onTogglePin={onTogglePin}
            onDeleteMessage={onDeleteMessage}
            jumpTarget={messageJumpTarget}
          />
        )}
      </section>

      <footer className={styles.composer}>
        <button
          type="button"
          className={styles.iconButton}
          title={t("chooseFile")}
          aria-label={t("chooseFile")}
          onClick={onSelectFile}
        >
          <Paperclip size={22} />
        </button>
        <div className={styles.composerInput}>
          {replyingTo && (
            <div className={styles.replyComposer}>
              <ArrowBendUpLeft size={19} />
              <button
                type="button"
                className={styles.replyComposerJump}
                onClick={() => onJumpToMessage(replyingTo.id)}
              >
                <strong>
                  {replyingTo.senderId === ownDeviceId
                    ? t("message.you")
                    : selectedPeer?.name || t("device")}
                </strong>
                <span>{messagePreview(replyingTo)}</span>
              </button>
              <button
                type="button"
                className={styles.replyComposerClose}
                title={t("message.cancelReply")}
                aria-label={t("message.cancelReply")}
                onClick={onCancelReply}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={
              savedConversation
                ? t("writeLocalMessage")
                : onlineForSelection
                  ? t("typeMessage")
                  : t("connectBeforeSend")
            }
            disabled={!savedConversation && !onlineForSelection}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
        </div>
        <button
          type="button"
          className={styles.sendButton}
          aria-label={t("sendMessage")}
          disabled={
            !draft.trim() ||
            (!savedConversation && !onlineForSelection)
          }
          onClick={onSend}
        >
          <PaperPlaneRight size={20} weight="fill" />
        </button>
      </footer>
    </main>
  );
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 7).toUpperCase();
}
