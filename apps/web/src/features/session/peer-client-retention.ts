export interface RetainedPeerClient {
  peerId: string;
  online: boolean;
}

export function peerIdsToPrune(
  clients: RetainedPeerClient[],
  selectedPeerId: string,
  maximum: number,
  reserveSlots: number,
): string[] {
  const pruneCount = Math.max(
    0,
    clients.length + reserveSlots - maximum,
  );
  const candidates = clients.filter(
    (client) => client.peerId !== selectedPeerId,
  );
  return [
    ...candidates.filter((client) => !client.online),
    ...candidates.filter((client) => client.online),
  ]
    .slice(0, pruneCount)
    .map((client) => client.peerId);
}
