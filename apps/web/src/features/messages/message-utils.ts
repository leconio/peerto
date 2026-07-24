import type { ReplyReference } from "@peerto/protocol";
import type { StoredMessage } from "../../store";

function localeFor(language: string): string {
  return language.startsWith("zh") ? "zh-CN" : "en";
}

export function formatMessageTime(
  time: number,
  language: string,
): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}

export function formatMessageDay(
  time: number,
  language: string,
  todayLabel: string,
): string {
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return todayLabel;
  return new Intl.DateTimeFormat(localeFor(language), {
    month: "long",
    day: "numeric",
  }).format(time);
}

export function messagePreview(message: StoredMessage): string {
  const preview =
    message.kind === "file" ? message.file?.name : message.text;
  return (preview?.trim() || "Message").slice(0, 500);
}

export function replyReference(
  message?: StoredMessage,
): ReplyReference | undefined {
  if (!message) return undefined;
  return {
    messageId: message.id,
    senderId: message.senderId,
    kind: message.kind,
    preview: messagePreview(message),
  };
}
