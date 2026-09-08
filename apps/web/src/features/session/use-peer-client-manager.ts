import type {
  DeviceIdentity,
  RendezvousInfo,
} from "@peerto/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ToastNotice } from "../../components/Toast";
import {
  loadIceServerSettings,
  rtcIceServersFromSettings,
  type IceServerSettings,
} from "../../lib/ice-settings";
import {
  identityDeviceName,
  shouldUseIdentityDeviceName,
} from "../../lib/device-name";
import { loadFirstDeviceName } from "../../lib/first-use";
import { loadIdentity, type LocalIdentity } from "../../lib/identity";
import type { ConnectionRoute } from "../../lib/network";
import { normalizeMaxActivePeerClients } from "../../lib/peer-client-settings";
import {
  cleanupStaleTemporaryFileReceives,
} from "../../services/file-transfer";
import {
  loadApiConfig,
  PeerClient,
  type ConnectionStatus,
  type IceAddressSnapshot,
  type ApiConfig,
  type RoomInfo,
  type RuntimeCode,
} from "../../services/peer";
import type {
  KnownPeer,
  StoredMessage,
} from "../../store";
import type { ConnectionDialogKind } from "../connection/ConnectionDialogs";
import type { TransferProgress } from "../transfers/types";
import { createPeerCallbacks } from "./create-peer-callbacks";
import { peerIdsToPrune } from "./peer-client-retention";
import { usePeerNetworkEvents } from "./use-peer-network-events";

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface PeerRuntime {
  status: ConnectionStatus;
  detail: RuntimeCode;
  route?: ConnectionRoute;
}

export interface PeerClientManagerBindings {
  deviceName: string;
  maxActivePeerClients: number;
  onRemoteConversationDelete: (peerId: string) => Promise<boolean>;
  selectedIdRef: MutableRefObject<string>;
  peersRef: MutableRefObject<KnownPeer[]>;
  sharedJoinHandledRef: MutableRefObject<boolean>;
  setDeviceName: (name: string) => void;
  setStatus: Setter<ConnectionStatus>;
  setStatusDetail: Setter<RuntimeCode>;
  setConnectionDialog: Setter<ConnectionDialogKind>;
  setRoom: Setter<RoomInfo | undefined>;
  setJoinRequest: Setter<DeviceIdentity | undefined>;
  setSelectedId: Setter<string>;
  setMobileConversation: Setter<boolean>;
  setReplyingTo: Setter<StoredMessage | undefined>;
  setPinnedCursor: Setter<number>;
  setProgress: Setter<Record<string, TransferProgress>>;
  setNotice: Setter<ToastNotice | undefined>;
  setIpProbing: Setter<boolean>;
  setIceSnapshot: Setter<IceAddressSnapshot | undefined>;
  setIceSettings: Setter<IceServerSettings>;
  upsertPeer: (
    peer: DeviceIdentity,
    rendezvous?: RendezvousInfo,
  ) => void;
  addMessage: (message: StoredMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (
    id: string,
    update: Partial<StoredMessage>,
  ) => void;
  setMessagePinned: (
    id: string,
    pinnedAt: number | null,
  ) => void;
}

export function usePeerClientManager({
  deviceName,
  maxActivePeerClients,
  onRemoteConversationDelete,
  selectedIdRef,
  peersRef,
  sharedJoinHandledRef,
  setDeviceName,
  setStatus,
  setStatusDetail,
  setConnectionDialog,
  setRoom,
  setJoinRequest,
  setSelectedId,
  setMobileConversation,
  setReplyingTo,
  setPinnedCursor,
  setProgress,
  setNotice,
  setIpProbing,
  setIceSnapshot,
  setIceSettings,
  upsertPeer,
  addMessage,
  removeMessage,
  updateMessage,
  setMessagePinned,
}: PeerClientManagerBindings) {
  const [identity, setIdentity] = useState<LocalIdentity>();
  const [client, setClient] = useState<PeerClient>();
  const [apiConfig, setApiConfig] = useState<ApiConfig>();
  const [peerRuntimes, setPeerRuntimes] = useState<
    Record<string, PeerRuntime>
  >({});
  const [peerClientsVersion, setPeerClientsVersion] = useState(0);
  const initialDeviceNameRef = useRef(deviceName);
  const maxActivePeerClientsRef = useRef(
    normalizeMaxActivePeerClients(maxActivePeerClients),
  );
  const clientRef = useRef<PeerClient | undefined>(undefined);
  const peerClientsRef = useRef(new Map<string, PeerClient>());
  const createdClientsRef = useRef(new Set<PeerClient>());
  const iceConnectionConfigRef = useRef<{
    iceServers: RTCIceServer[];
    relayOnly: boolean;
  } | undefined>(undefined);
  const createPeerClientRef = useRef<
    ((peerId: string) => PeerClient) | undefined
  >(undefined);

  maxActivePeerClientsRef.current = normalizeMaxActivePeerClients(
    maxActivePeerClients,
  );

  const prunePeerClients = useCallback(
    (maximum: number, reserveSlots: number) => {
      const clients = [...peerClientsRef.current.entries()].map(
        ([peerId, peerClient]) => ({
          peerId,
          online: peerClient.isOnline,
        }),
      );
      const prunedPeerIds = peerIdsToPrune(
        clients,
        selectedIdRef.current,
        maximum,
        reserveSlots,
      );
      if (prunedPeerIds.length === 0) return;
      for (const peerId of prunedPeerIds) {
        const prunedClient = peerClientsRef.current.get(peerId);
        prunedClient?.disconnect(false);
        if (prunedClient) createdClientsRef.current.delete(prunedClient);
        peerClientsRef.current.delete(peerId);
      }
      setPeerClientsVersion((version) => version + 1);
      setPeerRuntimes((current) => {
        const next = { ...current };
        for (const peerId of prunedPeerIds) {
          next[peerId] = {
            status: navigator.onLine
              ? "offline"
              : "network_offline",
            detail: navigator.onLine
              ? "peerOffline"
              : "networkOffline",
          };
        }
        return next;
      });
    },
    [selectedIdRef],
  );

  useEffect(() => {
    let disposed = false;
    const createdClients = createdClientsRef.current;

    const initialDeviceName = initialDeviceNameRef.current;
    const explicitlyNamed = Boolean(loadFirstDeviceName(localStorage));
    void Promise.all([loadIdentity(initialDeviceName), loadApiConfig()])
      .then(([loadedIdentity, config]) => {
        if (disposed) return;
        const resolvedDeviceName =
          !explicitlyNamed &&
          shouldUseIdentityDeviceName(
            initialDeviceName,
            navigator.platform,
          )
          ? identityDeviceName(loadedIdentity.device.deviceId)
          : initialDeviceName;
        const resolvedIdentity: LocalIdentity = {
          ...loadedIdentity,
          device: {
            ...loadedIdentity.device,
            name: resolvedDeviceName,
          },
        };
        const loadedIceSettings = loadIceServerSettings(config.iceServers);
        const effectiveConfig = {
          ...config,
          iceServers: rtcIceServersFromSettings(loadedIceSettings),
          relayOnly: Boolean(loadedIceSettings.relayOnly),
        };
        iceConnectionConfigRef.current = {
          iceServers: effectiveConfig.iceServers,
          relayOnly: effectiveConfig.relayOnly,
        };
        setIdentity(resolvedIdentity);
        setApiConfig(config);
        if (resolvedDeviceName !== initialDeviceName) {
          setDeviceName(resolvedDeviceName);
        }
        setIceSettings(loadedIceSettings);
        void cleanupStaleTemporaryFileReceives();

        const createManagedClient = (
          initialPeerId?: string,
        ): PeerClient => {
          const peerIdRef = { current: initialPeerId };
          let managedClient: PeerClient | undefined;
          const updateRuntime = (
            peerId: string,
            patch: Partial<PeerRuntime>,
          ) => {
            setPeerRuntimes((current) => ({
              ...current,
              [peerId]: {
                status:
                  current[peerId]?.status ||
                  (navigator.onLine
                    ? "offline"
                    : "network_offline"),
                detail:
                  current[peerId]?.detail ||
                  (navigator.onLine ? "ready" : "networkOffline"),
                ...current[peerId],
                ...patch,
              },
            }));
          };
          const scopedStatus: typeof setStatus = (action) => {
            const peerId = peerIdRef.current;
            if (!peerId) {
              setStatus(action);
              return;
            }
            setPeerRuntimes((current) => {
              const previous =
                current[peerId]?.status ||
                (navigator.onLine ? "offline" : "network_offline");
              const status =
                typeof action === "function"
                  ? action(previous)
                  : action;
              return {
                ...current,
                [peerId]: {
                  status,
                  detail:
                    current[peerId]?.detail ||
                    (navigator.onLine ? "ready" : "networkOffline"),
                  ...(current[peerId]?.route
                    ? { route: current[peerId].route }
                    : {}),
                },
              };
            });
          };
          const scopedDetail: typeof setStatusDetail = (action) => {
            const peerId = peerIdRef.current;
            if (!peerId) {
              setStatusDetail(action);
              return;
            }
            setPeerRuntimes((current) => {
              const previous =
                current[peerId]?.detail ||
                (navigator.onLine ? "ready" : "networkOffline");
              const detail =
                typeof action === "function"
                  ? action(previous)
                  : action;
              return {
                ...current,
                [peerId]: {
                  status:
                    current[peerId]?.status ||
                    (navigator.onLine
                      ? "offline"
                      : "network_offline"),
                  detail,
                  ...(current[peerId]?.route
                    ? { route: current[peerId].route }
                    : {}),
                },
              };
            });
          };
          const scopedRoute: Setter<ConnectionRoute | undefined> = (
            action,
          ) => {
            const peerId = peerIdRef.current;
            if (!peerId) return;
            setPeerRuntimes((current) => {
              const previous = current[peerId]?.route;
              const route =
                typeof action === "function"
                  ? action(previous)
                  : action;
              const base = {
                status:
                  current[peerId]?.status ||
                  (navigator.onLine
                    ? "offline"
                    : "network_offline"),
                detail:
                  current[peerId]?.detail ||
                  (navigator.onLine ? "ready" : "networkOffline"),
              };
              return {
                ...current,
                [peerId]: route ? { ...base, route } : base,
              };
            });
          };

          managedClient = new PeerClient(
            resolvedIdentity,
            {
              ...effectiveConfig,
              ...iceConnectionConfigRef.current,
            },
            createPeerCallbacks({
              peerIdRef,
              selectedIdRef,
              peersRef,
              sharedJoinHandledRef,
              getClient: () => managedClient,
              isPairingClient: () =>
                clientRef.current === managedClient,
              setStatus: scopedStatus,
              setStatusDetail: scopedDetail,
              setConnectionDialog,
              setRoom,
              setJoinRequest,
              onPeerConnected: (peer) => {
                if (!managedClient) return;
                const existing = peerClientsRef.current.get(
                  peer.deviceId,
                );
                if (existing && existing !== managedClient) {
                  existing.disconnect(false);
                  createdClients.delete(existing);
                }
                peerIdRef.current = peer.deviceId;
                peerClientsRef.current.delete(peer.deviceId);
                prunePeerClients(
                  maxActivePeerClientsRef.current,
                  1,
                );
                peerClientsRef.current.set(
                  peer.deviceId,
                  managedClient,
                );
                setPeerClientsVersion((version) => version + 1);
                updateRuntime(peer.deviceId, {});

                if (clientRef.current === managedClient) {
                  const replacement = createManagedClient();
                  clientRef.current = replacement;
                  setClient(replacement);
                  setStatus(
                    navigator.onLine ? "offline" : "network_offline",
                  );
                  setStatusDetail(
                    navigator.onLine ? "ready" : "networkOffline",
                  );
                  setIpProbing(false);
                }
              },
              setSelectedId,
              setMobileConversation,
              setReplyingTo,
              setPinnedCursor,
              setProgress,
              setNotice,
              setIpProbing: (value) => {
                if (clientRef.current === managedClient) {
                  setIpProbing(value);
                }
              },
              setIceSnapshot: (value) => {
                if (clientRef.current === managedClient) {
                  setIceSnapshot(value);
                }
              },
              setConnectionRoute: scopedRoute,
              upsertPeer,
              addMessage,
              removeMessage,
              updateMessage,
              setMessagePinned,
              onRemoteConversationDelete,
            }),
          );
          createdClients.add(managedClient);
          return managedClient;
        };

        createPeerClientRef.current = (peerId) => {
          const existing = peerClientsRef.current.get(peerId);
          if (existing) {
            peerClientsRef.current.delete(peerId);
            peerClientsRef.current.set(peerId, existing);
            return existing;
          }
          prunePeerClients(maxActivePeerClientsRef.current, 1);
          const peerClient = createManagedClient(peerId);
          peerClientsRef.current.set(peerId, peerClient);
          setPeerClientsVersion((version) => version + 1);
          return peerClient;
        };
        const currentClient = createManagedClient();
        clientRef.current = currentClient;
        setClient(currentClient);
        if (!navigator.onLine) {
          currentClient.setNetworkAvailable(false);
        }
        setIpProbing(false);
      })
      .catch(() => {
        setNotice({ key: "error.APP_INITIALIZATION_FAILED" });
        setIpProbing(false);
        setStatus("failed");
      });

    return () => {
      disposed = true;
      createPeerClientRef.current = undefined;
      clientRef.current = undefined;
      for (const createdClient of createdClients) {
        createdClient.disconnect(false);
      }
      peerClientsRef.current.clear();
      createdClients.clear();
    };
  }, [
    addMessage,
    peersRef,
    onRemoteConversationDelete,
    prunePeerClients,
    removeMessage,
    selectedIdRef,
    setConnectionDialog,
    setDeviceName,
    setIceSettings,
    setJoinRequest,
    setMessagePinned,
    setMobileConversation,
    setNotice,
    setPinnedCursor,
    setProgress,
    setReplyingTo,
    setRoom,
    setSelectedId,
    setStatus,
    setStatusDetail,
    sharedJoinHandledRef,
    updateMessage,
    upsertPeer,
  ]);

  useEffect(() => {
    prunePeerClients(maxActivePeerClientsRef.current, 0);
  }, [maxActivePeerClients, prunePeerClients]);

  const getPeerClient = useCallback(
    (peerId: string) => peerClientsRef.current.get(peerId),
    [],
  );
  const getOrCreatePeerClient = useCallback(
    (peerId: string) => createPeerClientRef.current?.(peerId),
    [],
  );
  const activatePeerClient = useCallback((peerId: string) => {
    const peerClient = peerClientsRef.current.get(peerId);
    if (!peerClient) return;
    peerClientsRef.current.delete(peerId);
    peerClientsRef.current.set(peerId, peerClient);
  }, []);
  const removePeerClient = useCallback((peerId: string) => {
    const removedClient = peerClientsRef.current.get(peerId);
    removedClient?.disconnect(false);
    if (removedClient) createdClientsRef.current.delete(removedClient);
    peerClientsRef.current.delete(peerId);
    setPeerClientsVersion((version) => version + 1);
    setPeerRuntimes((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);
  const setPeerOffline = useCallback(
    (peerId: string, detail: RuntimeCode) => {
      setPeerRuntimes((current) => ({
        ...current,
        [peerId]: {
          status: navigator.onLine
            ? "offline"
            : "network_offline",
          detail,
        },
      }));
    },
    [],
  );
  const setAllIceServers = useCallback(
    (iceServers: RTCIceServer[], relayOnly: boolean) => {
      iceConnectionConfigRef.current = { iceServers, relayOnly };
      clientRef.current?.setIceServers(iceServers, relayOnly);
      for (const peerClient of peerClientsRef.current.values()) {
        peerClient.setIceServers(iceServers, relayOnly);
      }
    },
    [],
  );
  const setAllDeviceNames = useCallback((name: string) => {
    clientRef.current?.setDeviceName(name);
    for (const peerClient of peerClientsRef.current.values()) {
      peerClient.setDeviceName(name);
    }
    setIdentity((current) =>
      current
        ? {
            ...current,
            device: { ...current.device, name },
          }
        : current,
    );
  }, []);

  usePeerNetworkEvents(
    client,
    peerClientsRef,
  );

  const onlinePeerIds = new Set(
    Object.entries(peerRuntimes)
      .filter(
        ([peerId, runtime]) =>
          runtime.status === "online" &&
          Boolean(peerClientsRef.current.get(peerId)?.isOnline),
      )
      .map(([peerId]) => peerId),
  );
  void peerClientsVersion;

  return {
    identity,
    client,
    apiConfig,
    peerRuntimes,
    onlinePeerIds,
    getPeerClient,
    getOrCreatePeerClient,
    activatePeerClient,
    removePeerClient,
    setPeerOffline,
    setAllIceServers,
    setAllDeviceNames,
  };
}
