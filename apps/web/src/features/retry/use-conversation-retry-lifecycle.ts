import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { useEffect } from "react";
import type { PeerClient } from "../../services/peer";
import type { KnownPeer } from "../../store";
import {
  reconnectBackoffDelayMs,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
} from "../../services/reconnect-backoff";
import type { ConversationRetryState } from "../../services/conversation-retry";

export interface ConversationRetryLifecycleBindings {
  retry: ConversationRetryState | undefined;
  peersRef: MutableRefObject<KnownPeer[]>;
  getOrCreateClient: (peerId: string) => PeerClient | undefined;
  getClient: (peerId: string) => PeerClient | undefined;
  setRetry: Dispatch<
    SetStateAction<ConversationRetryState | undefined>
  >;
}

export function useConversationRetryLifecycle({
  retry,
  peersRef,
  getOrCreateClient,
  getClient,
  setRetry,
}: ConversationRetryLifecycleBindings): void {
  useEffect(() => {
    if (!retry || retry.phase !== "attempting") return;

    const peer = peersRef.current.find(
      (candidate) => candidate.deviceId === retry.peerId,
    );
    if (!peer) {
      setRetry(undefined);
      return;
    }

    const moveToWaiting = () => {
      setRetry((current) =>
        current?.peerId === retry.peerId &&
        current.attempt === retry.attempt &&
        current.phase === "attempting"
          ? {
              peerId: current.peerId,
              attempt: current.attempt,
              phase: "waiting",
              nextAttemptAt:
                Date.now() +
                reconnectBackoffDelayMs(current.attempt),
            }
          : current,
      );
    };

    if (!navigator.onLine) {
      moveToWaiting();
      return;
    }
    const client = getOrCreateClient(retry.peerId);
    if (!client) {
      moveToWaiting();
      return;
    }
    if (client.isOnline) {
      setRetry(undefined);
      return;
    }

    let disposed = false;
    const timeout = window.setTimeout(() => {
      if (disposed) return;
      if (client.isOnline) {
        setRetry(undefined);
        return;
      }
      moveToWaiting();
    }, RECONNECT_ATTEMPT_TIMEOUT_MS);

    const reconnect = async () => {
      if (peer.connectionCode && peer.connectionToken) {
        const result = await client.refreshPeer({
          deviceId: peer.deviceId,
          code: peer.connectionCode,
          token: peer.connectionToken,
          ...(peer.customIp ? { customIp: peer.customIp } : {}),
        });
        if (result === "cancelled" && !disposed) moveToWaiting();
        return;
      }
      const started = await client.reconnectPeer(
        peer.deviceId,
        peer.customIp,
      );
      if (!started && !disposed) moveToWaiting();
    };

    void reconnect().catch(() => {
      if (!disposed) moveToWaiting();
    });

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [
    getOrCreateClient,
    peersRef,
    retry?.attempt,
    retry?.peerId,
    retry?.phase,
    setRetry,
  ]);

  useEffect(() => {
    if (!retry || retry.phase !== "waiting") return;

    const client = getClient(retry.peerId);
    if (client && !client.isOnline) {
      client?.disconnect(false);
    }
    if (!navigator.onLine) return;
    const delay = Math.max(
      0,
      (retry.nextAttemptAt || Date.now()) - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setRetry((current) =>
        current?.peerId === retry.peerId &&
        current.attempt === retry.attempt &&
        current.phase === "waiting"
          ? {
              peerId: current.peerId,
              attempt: current.attempt + 1,
              phase: "attempting",
            }
          : current,
      );
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    getClient,
    retry?.attempt,
    retry?.nextAttemptAt,
    retry?.peerId,
    retry?.phase,
    setRetry,
  ]);
}
