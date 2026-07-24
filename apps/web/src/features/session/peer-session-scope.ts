import type { ConversationRetryState } from "../../services/conversation-retry";

export function shouldOpenPeerConversation(
  pairingConnection: boolean,
  selectedPeerId: string,
  connectedPeerId: string,
): boolean {
  return pairingConnection || selectedPeerId === connectedPeerId;
}

export function retryCanBeUpdatedByPeer(
  retry: ConversationRetryState | undefined,
  peerId: string | undefined,
): boolean {
  return !retry || !peerId || retry.peerId === peerId;
}
