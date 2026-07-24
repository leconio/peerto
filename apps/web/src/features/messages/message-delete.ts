import type { StoredMessage } from "../../store";

export function canPeerDeleteMessage(
  message: StoredMessage | undefined,
  peerId: string | undefined,
): boolean {
  if (!message) return true;
  return Boolean(
    peerId &&
      message.conversationId === peerId &&
      message.senderId === peerId,
  );
}
