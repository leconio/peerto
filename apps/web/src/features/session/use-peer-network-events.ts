import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { useEffect } from "react";
import type { PeerClient } from "../../services/peer";
import {
  conversationRetryAfterNetworkReturn,
  type ConversationRetryState,
} from "../../services/conversation-retry";

interface NetworkAwarePeerClient {
  setNetworkAvailable: (
    online: boolean,
    probeAddresses?: boolean,
  ) => void;
}

export function updatePeerClientsForNetwork(
  online: boolean,
  pairingClient: NetworkAwarePeerClient,
  sessionClients: Iterable<NetworkAwarePeerClient>,
): void {
  pairingClient.setNetworkAvailable(online);
  for (const peerClient of sessionClients) {
    peerClient.setNetworkAvailable(online, online ? false : undefined);
  }
}

export function usePeerNetworkEvents(
  client: PeerClient | undefined,
  peerClientsRef: MutableRefObject<Map<string, PeerClient>>,
  selectedIdRef: MutableRefObject<string>,
  setConversationRetry: Dispatch<
    SetStateAction<ConversationRetryState | undefined>
  >,
): void {
  useEffect(() => {
    if (!client) return;
    const onOnline = () => {
      updatePeerClientsForNetwork(
        true,
        client,
        peerClientsRef.current.values(),
      );
      setConversationRetry((current) =>
        conversationRetryAfterNetworkReturn(
          current,
          selectedIdRef.current,
        ),
      );
    };
    const onOffline = () => {
      updatePeerClientsForNetwork(
        false,
        client,
        peerClientsRef.current.values(),
      );
    };
    const connection = (
      navigator as Navigator & { connection?: EventTarget }
    ).connection;
    const onConnectionChange = () => {
      if (navigator.onLine && !client.isOnline) {
        void client.probePublicAddresses();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    connection?.addEventListener("change", onConnectionChange);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      connection?.removeEventListener("change", onConnectionChange);
    };
  }, [
    client,
    peerClientsRef,
    selectedIdRef,
    setConversationRetry,
  ]);
}
