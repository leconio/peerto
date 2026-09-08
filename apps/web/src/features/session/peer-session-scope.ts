export function shouldOpenPeerConversation(
  pairingConnection: boolean,
  selectedPeerId: string,
  connectedPeerId: string,
): boolean {
  return pairingConnection || selectedPeerId === connectedPeerId;
}
