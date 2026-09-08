import type { MutableRefObject } from "react";
import { useEffect } from "react";
import type { PeerClient } from "../../services/peer";

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
  pairingClient.setNetworkAvailable(online, false);
  for (const peerClient of sessionClients) {
    peerClient.setNetworkAvailable(online, false);
  }
}

export function usePeerNetworkEvents(
  client: PeerClient | undefined,
  peerClientsRef: MutableRefObject<Map<string, PeerClient>>,
): void {
  useEffect(() => {
    if (!client) return;
    const onOnline = () => {
      updatePeerClientsForNetwork(
        true,
        client,
        peerClientsRef.current.values(),
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
        client.invalidatePublicAddresses();
      }
    };
    const onResume = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      client.checkConnectionAfterResume();
      for (const peerClient of peerClientsRef.current.values()) {
        peerClient.checkConnectionAfterResume();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    connection?.addEventListener("change", onConnectionChange);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      connection?.removeEventListener("change", onConnectionChange);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [
    client,
    peerClientsRef,
  ]);
}
