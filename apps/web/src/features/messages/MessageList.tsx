import {
  ArrowBendUpLeft,
  Check,
  Copy,
  DotsThreeVertical,
  PushPin,
  PushPinSlash,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deviceAvatarLabel } from "../../lib/device-name";
import styles from "../../styles/ui.module.css";
import type { StoredMessage } from "../../store";
import type { TransferProgress } from "../transfers/types";
import { FileMessageContent } from "./FileMessageContent";
import {
  formatMessageDay,
  formatMessageTime,
} from "./message-utils";
import type { MessageJumpTarget } from "./types";

export interface MessageListProps {
  messages: StoredMessage[];
  ownDeviceId: string | undefined;
  peerName: string | undefined;
  peerDeviceId: string | undefined;
  progress: Record<string, TransferProgress>;
  canStopTransfer: boolean;
  onOpenFile: (message: StoredMessage) => void;
  onStopFile: (message: StoredMessage) => void;
  onCopyMessage: (message: StoredMessage) => void;
  onReply: (message: StoredMessage) => void;
  onTogglePin: (message: StoredMessage) => void;
  onDeleteMessage: (message: StoredMessage) => void;
  jumpTarget: MessageJumpTarget | undefined;
}

export function MessageList({
  messages,
  ownDeviceId,
  peerName,
  peerDeviceId,
  progress,
  canStopTransfer,
  onOpenFile,
  onStopFile,
  onCopyMessage,
  onReply,
  onTogglePin,
  onDeleteMessage,
  jumpTarget,
}: MessageListProps) {
  const { t, i18n } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const [highlightedMessageId, setHighlightedMessageId] =
    useState<string>();
  const [messageMenu, setMessageMenu] = useState<{
    messageId: string;
    x: number;
    y: number;
  }>();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const focusMessage = (messageId: string) => {
    const element = messageRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? "auto"
        : "smooth",
      block: "center",
    });
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(
      () => setHighlightedMessageId(undefined),
      1_450,
    );
  };

  useEffect(() => {
    if (jumpTarget) focusMessage(jumpTarget.messageId);
  }, [jumpTarget?.requestId]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!messageMenu) return;
    const closeMenu = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setMessageMenu(undefined);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMessageMenu(undefined);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [messageMenu]);

  const openMessageMenu = (
    messageId: string,
    clientX: number,
    clientY: number,
  ) => {
    setMessageMenu({
      messageId,
      x: Math.max(8, Math.min(clientX, window.innerWidth - 196)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - 190)),
    });
  };

  const menuMessage = messages.find(
    (message) => message.id === messageMenu?.messageId,
  );

  let previousDay = "";
  return (
    <div className={styles.messageList}>
      {messages.map((message) => {
        const day = formatMessageDay(
          message.createdAt,
          i18n.language,
          t("today"),
        );
        const showDay = day !== previousDay;
        previousDay = day;
        const mine = message.senderId === ownDeviceId;
        const transfer = progress[message.id];

        return (
          <div key={message.id}>
            {showDay && <div className={styles.dayDivider}>{day}</div>}
            <div
              className={`${styles.messageRow} ${
                mine ? styles.messageRowMine : ""
              }`}
            >
              {!mine && (
                <span
                  className={styles.messagePeerAvatar}
                  title={peerName}
                  aria-hidden="true"
                >
                  {deviceAvatarLabel(
                    peerName || "",
                    peerDeviceId || message.senderId,
                  )}
                </span>
              )}
              <article
                ref={(element) => {
                  if (element) {
                    messageRefs.current.set(message.id, element);
                  } else {
                    messageRefs.current.delete(message.id);
                  }
                }}
                className={`${styles.messageBubble} ${
                  mine ? styles.messageBubbleMine : ""
                } ${message.kind === "file" ? styles.fileBubble : ""} ${
                  highlightedMessageId === message.id
                    ? styles.messageHighlighted
                    : ""
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMessageMenu(
                    message.id,
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                {message.replyTo && (
                  <button
                    type="button"
                    className={styles.replyPreview}
                    onClick={() => focusMessage(message.replyTo!.messageId)}
                  >
                    <strong>
                      {message.replyTo.senderId === ownDeviceId
                        ? t("message.you")
                        : peerName || t("device")}
                    </strong>
                    <span>{message.replyTo.preview}</span>
                  </button>
                )}
                {message.kind === "text" ? (
                  <p>{message.text}</p>
                ) : (
                  <FileMessageContent
                    message={message}
                    transfer={transfer}
                    onOpen={() => onOpenFile(message)}
                    onStop={() => onStopFile(message)}
                    canStop={canStopTransfer}
                  />
                )}
                <footer>
                  {message.pinnedAt && (
                    <PushPin
                      size={11}
                      weight="fill"
                      aria-label={t("message.pinnedIcon")}
                    />
                  )}
                  <time>
                    {formatMessageTime(
                      message.createdAt,
                      i18n.language,
                    )}
                  </time>
                  {mine && message.status !== "local" && (
                    <span
                      className={
                        message.status === "delivered"
                          ? styles.delivered
                          : ""
                      }
                    >
                      {message.status === "failed" ? (
                        <X size={13} weight="bold" />
                      ) : (
                        <>
                          <Check size={13} weight="bold" />
                          {message.status === "delivered" && (
                            <Check
                              size={13}
                              weight="bold"
                              className={styles.secondCheck}
                            />
                          )}
                        </>
                      )}
                    </span>
                  )}
                </footer>
                <button
                  type="button"
                  className={styles.messageActionsButton}
                  title={t("message.actions")}
                  aria-label={t("message.actions")}
                  onClick={(event) => {
                    event.stopPropagation();
                    const bounds =
                      event.currentTarget.getBoundingClientRect();
                    openMessageMenu(
                      message.id,
                      mine ? bounds.left - 160 : bounds.right,
                      bounds.top,
                    );
                  }}
                >
                  <DotsThreeVertical size={18} weight="bold" />
                </button>
              </article>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
      {messageMenu && menuMessage && (
        <div
          ref={menuRef}
          className={styles.messageContextMenu}
          role="menu"
          aria-label={t("message.actions")}
          style={{ left: messageMenu.x, top: messageMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onReply(menuMessage);
              setMessageMenu(undefined);
            }}
          >
            <ArrowBendUpLeft size={18} />
            {t("message.reply")}
          </button>
          {menuMessage.kind === "text" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCopyMessage(menuMessage);
                setMessageMenu(undefined);
              }}
            >
              <Copy size={18} />
              {t("message.copy")}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onTogglePin(menuMessage);
              setMessageMenu(undefined);
            }}
          >
            {menuMessage.pinnedAt ? (
              <PushPinSlash size={18} />
            ) : (
              <PushPin size={18} />
            )}
            {t(
              menuMessage.pinnedAt
                ? "message.unpin"
                : "message.pin",
            )}
          </button>
          {menuMessage.senderId === ownDeviceId && (
            <button
              type="button"
              role="menuitem"
              className={styles.messageContextMenuDanger}
              onClick={() => {
                onDeleteMessage(menuMessage);
                setMessageMenu(undefined);
              }}
            >
              <Trash size={18} />
              {t("message.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
