import type { DeviceIdentity } from "@peerto/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Toast, type ToastNotice } from "./components/Toast";
import { ChatPane } from "./features/chat/ChatPane";
import {
  ConnectionDialogs,
  type ConnectionDialogKind,
} from "./features/connection/ConnectionDialogs";
import { CustomIpDialog } from "./features/connection/CustomIpDialog";
import {
  type PendingSharedJoin,
  sharedJoinFromLocation,
  shareUrl,
} from "./features/connection/share-link";
import { useConnectionActions } from "./features/connection/use-connection-actions";
import { useSharedJoin } from "./features/connection/use-shared-join";
import { ConversationSidebar } from "./features/conversations/ConversationSidebar";
import { deleteConversationTransaction } from "./features/conversations/conversation-delete";
import { messagePreview } from "./features/messages/message-utils";
import type { MessageJumpTarget } from "./features/messages/types";
import { useMessageActions } from "./features/messages/use-message-actions";
import {
  ResourceViewerDialog,
  type ResourceViewerState,
} from "./features/resources/ResourceViewerDialog";
import { useResourceActions } from "./features/resources/use-resource-actions";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { TurnstileDialog } from "./features/security/TurnstileDialog";
import { ConversationRetryOverlay } from "./features/retry/ConversationRetryOverlay";
import { useConversationRetryLifecycle } from "./features/retry/use-conversation-retry-lifecycle";
import { usePeerClientManager } from "./features/session/use-peer-client-manager";
import type { TransferProgress } from "./features/transfers/types";
import { useFileSelection } from "./features/transfers/use-file-selection";
import { useAutoDismiss } from "./hooks/use-auto-dismiss";
import { useDismissibleMenu } from "./hooks/use-dismissible-menu";
import {
  DEFAULT_STUN_URLS,
  iceServerSettingsFromRtc,
  type IceServerSettings,
  normalizeIceServerSettings,
  rtcIceServersFromSettings,
  saveIceServerSettings,
} from "./lib/ice-settings";
import { canReuseHostRoom } from "./lib/host-room";
import { normalizeCustomIp } from "./lib/custom-ip";
import {
  loadMaxActivePeerClients,
  saveMaxActivePeerClients,
} from "./lib/peer-client-settings";
import {
  type ConnectionStatus,
  type IceAddressSnapshot,
  type RoomInfo,
  type RuntimeCode,
  PeerClientError,
} from "./services/peer";
import type { ConversationRetryState } from "./services/conversation-retry";
import {
  SAVED_CONVERSATION_ID,
  type KnownPeer,
  type StoredMessage,
  useAppStore,
} from "./store";
import styles from "./styles/ui.module.css";

const INITIAL_ICE_SETTINGS = iceServerSettingsFromRtc([
  { urls: DEFAULT_STUN_URLS },
]);

export function App() {
  const { t, i18n } = useTranslation();
  const {
    deviceName,
    theme,
    peers,
    messages,
    setDeviceName,
    setTheme,
    upsertPeer,
    removeConversation,
    setPeerCustomIp,
    addMessage,
    removeMessage,
    updateMessage,
    setMessagePinned,
  } = useAppStore();
  const [status, setStatus] = useState<ConnectionStatus>(
    navigator.onLine ? "offline" : "network_offline",
  );
  const [statusDetail, setStatusDetail] = useState<RuntimeCode>(
    navigator.onLine ? "ready" : "networkOffline",
  );
  const [selectedId, setSelectedId] = useState(SAVED_CONVERSATION_ID);
  const selectedIdRef = useRef(SAVED_CONVERSATION_ID);
  const [mobileConversation, setMobileConversation] = useState(false);
  const [connectionDialog, setConnectionDialog] =
    useState<ConnectionDialogKind>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);
  const [conversationRetry, setConversationRetry] =
    useState<ConversationRetryState>();
  const [deleteConfirmation, setDeleteConfirmation] =
    useState<KnownPeer>();
  const [deleteForPeer, setDeleteForPeer] = useState(false);
  const [deleteConversationPending, setDeleteConversationPending] =
    useState(false);
  const [customIpPeer, setCustomIpPeer] = useState<KnownPeer>();
  const [customIpDraft, setCustomIpDraft] = useState("");
  const [customIpError, setCustomIpError] = useState<string>();
  const [room, setRoom] = useState<RoomInfo>();
  const [joinCode, setJoinCode] = useState("");
  const [joinRequest, setJoinRequest] = useState<DeviceIdentity>();
  const [openFilePickerAvailable, setOpenFilePickerAvailable] =
    useState(() => typeof window.showOpenFilePicker === "function");
  const [progress, setProgress] = useState<
    Record<string, TransferProgress>
  >({});
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<StoredMessage>();
  const [pinnedCursor, setPinnedCursor] = useState(0);
  const [messageJumpTarget, setMessageJumpTarget] =
    useState<MessageJumpTarget>();
  const [resourceViewer, setResourceViewer] =
    useState<ResourceViewerState>();
  const [notice, setNotice] = useState<ToastNotice>();
  const [turnstileRequest, setTurnstileRequest] = useState<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  }>();
  const [copied, setCopied] = useState<"code" | "link">();
  const [now, setNow] = useState(Date.now());
  const [ipProbing, setIpProbing] = useState(navigator.onLine);
  const [iceSnapshot, setIceSnapshot] =
    useState<IceAddressSnapshot>();
  const [iceSettings, setIceSettings] = useState<IceServerSettings>(
    INITIAL_ICE_SETTINGS,
  );
  const [maxActivePeerClients, setMaxActivePeerClients] = useState(
    loadMaxActivePeerClients,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const peerMenuRef = useRef<HTMLDivElement>(null);
  const pendingSharedJoinRef = useRef<PendingSharedJoin | undefined>(
    sharedJoinFromLocation(),
  );
  const sharedJoinHandledRef = useRef(false);
  const peersRef = useRef(peers);
  peersRef.current = peers;
  selectedIdRef.current = selectedId;

  const onRemoteConversationDelete = useCallback(
    async (peerId: string): Promise<boolean> => {
      const state = useAppStore.getState();
      const messageIds = new Set(
        state.messages
          .filter((message) => message.conversationId === peerId)
          .map((message) => message.id),
      );
      const deleted = await state.removeConversation(peerId);
      if (!deleted) return false;

      setProgress((current) => {
        const next = { ...current };
        for (const messageId of messageIds) delete next[messageId];
        return next;
      });
      setConversationRetry((current) =>
        current?.peerId === peerId ? undefined : current,
      );
      setDeleteConfirmation((current) =>
        current?.deviceId === peerId ? undefined : current,
      );
      setCustomIpPeer((current) =>
        current?.deviceId === peerId ? undefined : current,
      );
      setResourceViewer((current) =>
        current?.message.conversationId === peerId
          ? undefined
          : current,
      );
      if (selectedIdRef.current === peerId) {
        setPeerMenuOpen(false);
        setReplyingTo(undefined);
        setPinnedCursor(0);
        setSelectedId(SAVED_CONVERSATION_ID);
        setMobileConversation(false);
      }
      setNotice({ key: "deleteConversation.deletedByPeer" });
      return true;
    },
    [],
  );

  const {
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
  } = usePeerClientManager({
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
    setConversationRetry,
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
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#111719" : "#f5f7f8");
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useSharedJoin({
    client,
    pendingRef: pendingSharedJoinRef,
    handledRef: sharedJoinHandledRef,
    setJoinCode,
    setConnectionDialog,
  });
  useConversationRetryLifecycle({
    retry: conversationRetry,
    peersRef,
    getOrCreateClient: getOrCreatePeerClient,
    getClient: getPeerClient,
    setRetry: setConversationRetry,
  });
  useAutoDismiss(notice, setNotice, 4_000);
  useDismissibleMenu(peerMenuOpen, peerMenuRef, setPeerMenuOpen);

  const selectedPeer = peers.find((peer) => peer.deviceId === selectedId);
  const selectedMessages = useMemo(
    () =>
      messages
        .filter((message) => message.conversationId === selectedId)
        .sort((left, right) => left.createdAt - right.createdAt),
    [messages, selectedId],
  );
  const resourceMessages = useMemo(
    () =>
      messages
        .filter(
          (message) =>
            message.kind === "file" &&
            Boolean(
              message.file?.handleKey ||
                message.file?.resourceKey,
            ),
        )
        .sort((left, right) => right.createdAt - left.createdAt),
    [messages],
  );
  const pinnedMessages = useMemo(
    () =>
      selectedMessages
        .filter(
          (message): message is StoredMessage & { pinnedAt: number } =>
            typeof message.pinnedAt === "number",
        )
        .sort((left, right) => right.pinnedAt - left.pinnedAt),
    [selectedMessages],
  );
  const activePinnedMessage =
    pinnedMessages.length > 0
      ? pinnedMessages[pinnedCursor % pinnedMessages.length]
      : undefined;
  const selectedClient = getPeerClient(selectedId);
  const selectedRuntime = peerRuntimes[selectedId];
  const onlineForSelection =
    selectedRuntime?.status === "online" &&
    Boolean(selectedClient?.isOnline);
  const deletePeerOnline = Boolean(
    deleteConfirmation &&
      onlinePeerIds.has(deleteConfirmation.deviceId) &&
      getPeerClient(deleteConfirmation.deviceId)?.isOnline,
  );
  const retryPeer = conversationRetry
    ? peers.find((peer) => peer.deviceId === conversationRetry.peerId)
    : undefined;
  const retrySecondsRemaining =
    conversationRetry?.phase === "waiting"
      ? Math.max(
          0,
          Math.ceil(
            ((conversationRetry.nextAttemptAt || now) - now) / 1_000,
          ),
        )
      : 0;
  const secondsRemaining = room
    ? Math.max(0, Math.ceil((room.expiresAt - now) / 1_000))
    : 0;
  const connectionRoute = selectedRuntime?.route;
  const connectionRouteLabel = connectionRoute
    ? t(`connectionRoute.${connectionRoute.kind}`)
    : t("p2pConnected");
  const automaticRouteSummary =
    connectionRoute?.protocol
      ? t("connectionRoute.withProtocol", {
          route: connectionRouteLabel,
          protocol: connectionRoute.protocol.toUpperCase(),
        })
      : connectionRouteLabel;
  const connectionRouteSummary =
    selectedPeer?.customIp && onlineForSelection
      ? t("connectionRoute.customIp", {
          route: automaticRouteSummary,
        })
      : automaticRouteSummary;

  const requestHumanVerification = useCallback((): Promise<string> => {
    if (!apiConfig?.turnstileSiteKey) {
      return Promise.reject(
        new PeerClientError("TURNSTILE_FAILED"),
      );
    }
    return new Promise<string>((resolve, reject) => {
      setTurnstileRequest({ resolve, reject });
    });
  }, [apiConfig?.turnstileSiteKey]);

  const failHumanVerification = useCallback(() => {
    setTurnstileRequest((current) => {
      current?.reject(new PeerClientError("TURNSTILE_FAILED"));
      return undefined;
    });
  }, []);

  const finishHumanVerification = useCallback((token: string) => {
    setTurnstileRequest((current) => {
      current?.resolve(token);
      return undefined;
    });
  }, []);

  const {
    cancelConversationRetry,
    createRoom,
    refreshPublicAddresses,
    retryConversationImmediately,
    selectConversation,
    submitJoin,
  } = useConnectionActions({
    client,
    room,
    ipProbing,
    joinCode,
    getPeerClient,
    activatePeerClient,
    inputRef,
    setConversationRetry,
    setPeerMenuOpen,
    setReplyingTo,
    setPinnedCursor,
    setSelectedId,
    setMobileConversation,
    setNotice,
    setPeerOffline,
    setRoom,
    setConnectionDialog,
    setStatus,
    setStatusDetail,
    requestHumanVerification,
  });

  const deleteSelectedConversation = async () => {
    const peer = deleteConfirmation;
    if (!peer || deleteConversationPending) return;
    const messageIds = new Set(
      useAppStore
        .getState()
        .messages.filter(
          (message) => message.conversationId === peer.deviceId,
        )
        .map((message) => message.id),
    );

    const peerClient = getPeerClient(peer.deviceId);
    if (
      deleteForPeer &&
      (!deletePeerOnline || !peerClient?.isOnline)
    ) {
      setNotice({
        key: "error.REMOTE_CONVERSATION_DELETE_FAILED",
      });
      return;
    }

    setDeleteConversationPending(true);
    const result = await deleteConversationTransaction({
      ...(deleteForPeer
        ? {
            deleteRemote: () => peerClient!.deleteConversation(),
          }
        : {}),
      deleteLocal: async () => {
        await peerClient?.prepareConversationDeletion();
        return removeConversation(peer.deviceId);
      },
    });
    if (result !== "deleted") {
      setDeleteConversationPending(false);
      setNotice({
        key:
          result === "remote_failed"
            ? "error.REMOTE_CONVERSATION_DELETE_FAILED"
            : "error.LOCAL_CONVERSATION_DELETE_FAILED",
      });
      return;
    }

    removePeerClient(peer.deviceId);
    setConversationRetry((current) =>
      current?.peerId === peer.deviceId ? undefined : current,
    );
    setProgress((current) => {
      const next = { ...current };
      for (const messageId of messageIds) delete next[messageId];
      return next;
    });
    setResourceViewer((current) =>
      current?.message.conversationId === peer.deviceId
        ? undefined
        : current,
    );
    setDeleteConfirmation(undefined);
    setDeleteForPeer(false);
    setDeleteConversationPending(false);
    setPeerMenuOpen(false);
    setRoom(undefined);
    setReplyingTo(undefined);
    setPinnedCursor(0);
    setSelectedId(SAVED_CONVERSATION_ID);
    setMobileConversation(false);
    setNotice({ key: "peerMenu.deleted" });
  };

  const {
    deleteOwnMessage,
    handleComposerKeyDown,
    openActivePinnedMessage,
    requestMessageJump,
    sendMessage,
    startReply,
    toggleMessagePin,
  } = useMessageActions({
    selectedId,
    identity,
    replyingTo,
    draft,
    client: selectedClient,
    onlineForSelection,
    activePinnedMessage,
    pinnedMessages,
    inputRef,
    setReplyingTo,
    setDraft,
    setPinnedCursor,
    setMessageJumpTarget,
    setNotice,
    addMessage,
    removeMessage,
    setMessagePinned,
  });

  const { onMobileFileSelected, selectFile } = useFileSelection({
    identity,
    replyingTo,
    selectedId,
    onlineForSelection,
    client: selectedClient,
    openFilePickerAvailable,
    fileInputRef,
    setOpenFilePickerAvailable,
    setReplyingTo,
    setNotice,
    setProgress,
    addMessage,
    updateMessage,
  });

  const {
    clearStoredResources,
    closeResourceViewer,
    deleteStoredResource,
    downloadStoredResource,
    openResourcePreview,
  } = useResourceActions({
    resourceMessages,
    resourceViewer,
    setResourceViewer,
    setNotice,
    updateMessage,
  });

  const copyText = async (value: string, type: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(type);
      if (type === "link") setNotice({ key: "action.linkCopied" });
      window.setTimeout(() => setCopied(undefined), 1_500);
    } catch {
      setNotice({ key: "error.CLIPBOARD_FAILED" });
    }
  };

  const shareRoom = async () => {
    if (!room?.shareToken) return;
    const url = shareUrl(room);
    if (!navigator.share) {
      await copyText(url, "link");
      return;
    }
    try {
      await navigator.share({
        title: t("hostDialog.shareTitle"),
        text: t("hostDialog.shareText"),
        url,
      });
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setNotice({ key: "error.SHARE_FAILED" });
      }
    }
  };

  const reconnectAfterCustomIpChange = (
    peer: KnownPeer,
    customIp: string | undefined,
  ) => {
    setPeerCustomIp(peer.deviceId, customIp);
    getPeerClient(peer.deviceId)?.disconnect(false);
    setPeerOffline(
      peer.deviceId,
      navigator.onLine ? "peerOffline" : "networkOffline",
    );
    setCustomIpPeer(undefined);
    setCustomIpError(undefined);
    setConversationRetry({
      peerId: peer.deviceId,
      attempt: 1,
      phase: "attempting",
    });
    setNotice({
      key: customIp ? "customIp.saved" : "customIp.cleared",
    });
  };

  const saveCustomIp = () => {
    if (!customIpPeer) return;
    const customIp = normalizeCustomIp(customIpDraft);
    if (!customIp) {
      setCustomIpError(t("customIp.invalid"));
      return;
    }
    reconnectAfterCustomIpChange(customIpPeer, customIp);
  };

  return (
    <div className={styles.appShell}>
      <input
        ref={fileInputRef}
        className={styles.hiddenFileInput}
        type="file"
        onChange={onMobileFileSelected}
      />

      <ConversationSidebar
        hiddenOnMobile={mobileConversation}
        peers={peers}
        selectedId={selectedId}
        onlinePeerIds={onlinePeerIds}
        status={status}
        ipProbing={ipProbing}
        iceSnapshot={iceSnapshot}
        connectionActionsDisabled={
          !client || status === "network_offline"
        }
        refreshIpDisabled={
          !client || ipProbing || status === "network_offline"
        }
        onRefreshIp={() => void refreshPublicAddresses()}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectConversation={selectConversation}
        onCreateRoom={() => void createRoom()}
        onOpenJoin={() => {
          setJoinCode("");
          setConnectionDialog("join");
        }}
      />

      <ChatPane
        visibleOnMobile={mobileConversation}
        selectedId={selectedId}
        selectedPeer={selectedPeer}
        selectedMessages={selectedMessages}
        ownDeviceId={identity?.device.deviceId}
        onlineForSelection={onlineForSelection}
        connectionRouteSummary={connectionRouteSummary}
        peerMenuOpen={peerMenuOpen}
        peerMenuRef={peerMenuRef}
        activePinnedMessage={activePinnedMessage}
        pinnedMessages={pinnedMessages}
        pinnedCursor={pinnedCursor}
        progress={progress}
        messageJumpTarget={messageJumpTarget}
        replyingTo={replyingTo}
        draft={draft}
        inputRef={inputRef}
        onBack={() => setMobileConversation(false)}
        onTogglePeerMenu={() => setPeerMenuOpen((open) => !open)}
        onConfigureCustomIp={() => {
          setPeerMenuOpen(false);
          if (!selectedPeer) return;
          setCustomIpPeer(selectedPeer);
          setCustomIpDraft(selectedPeer.customIp || "");
          setCustomIpError(undefined);
        }}
        onDeleteConversation={() => {
          setPeerMenuOpen(false);
          if (selectedPeer) {
            setDeleteForPeer(false);
            setDeleteConversationPending(false);
            setDeleteConfirmation(selectedPeer);
          }
        }}
        onOpenPinnedMessage={openActivePinnedMessage}
        onTogglePin={toggleMessagePin}
        onDeleteMessage={deleteOwnMessage}
        onOpenFile={(message) => void openResourcePreview(message)}
        onStopFile={(message) => {
          if (
            !onlineForSelection ||
            !selectedClient?.cancelFile(message.id)
          ) {
            setNotice({ key: "error.DEVICE_OFFLINE" });
          }
        }}
        onReply={startReply}
        onJumpToMessage={requestMessageJump}
        onCancelReply={() => setReplyingTo(undefined)}
        onSelectFile={() => void selectFile()}
        onDraftChange={setDraft}
        onComposerKeyDown={handleComposerKeyDown}
        onSend={sendMessage}
      />

      <ConnectionDialogs
        dialog={connectionDialog}
        room={room}
        status={status}
        secondsRemaining={secondsRemaining}
        copied={copied}
        joinCode={joinCode}
        joinRequest={joinRequest}
        deleteConfirmation={deleteConfirmation}
        deletePeerOnline={deletePeerOnline}
        deleteForPeer={deleteForPeer}
        deletePending={deleteConversationPending}
        onCloseHost={() => {
          const reusableRoom = canReuseHostRoom(
            room,
            client?.activeHostRoomCode,
          );
          if (!reusableRoom) {
            client?.disconnect();
            setRoom(undefined);
          }
          setJoinRequest(undefined);
          setConnectionDialog(null);
        }}
        onCopyCode={() => {
          if (room) void copyText(room.code, "code");
        }}
        onShareRoom={() => void shareRoom()}
        onCopyShareLink={() => {
          if (room) void copyText(shareUrl(room), "link");
        }}
        onCloseJoin={() => {
          const reusableRoom = canReuseHostRoom(
            room,
            client?.activeHostRoomCode,
          );
          if (!reusableRoom && status !== "online") {
            client?.disconnect();
          }
          setConnectionDialog(null);
        }}
        onJoinCodeChange={setJoinCode}
        onJoinSubmit={submitJoin}
        onCloseAuto={() => {
          sharedJoinHandledRef.current = false;
          client?.disconnect();
          setConnectionDialog(null);
        }}
        onRejectPeer={(deviceId) => {
          client?.rejectPeer(deviceId);
          setJoinRequest(undefined);
        }}
        onAcceptPeer={(deviceId) => {
          client?.acceptPeer(deviceId);
          setJoinRequest(undefined);
        }}
        onCloseDelete={() => {
          if (deleteConversationPending) return;
          setDeleteConfirmation(undefined);
          setDeleteForPeer(false);
        }}
        onDeleteForPeerChange={setDeleteForPeer}
        onConfirmDelete={() => void deleteSelectedConversation()}
      />

      {customIpPeer && (
        <CustomIpDialog
          peer={customIpPeer}
          value={customIpDraft}
          error={customIpError}
          onValueChange={(value) => {
            setCustomIpDraft(value);
            setCustomIpError(undefined);
          }}
          onSave={(event) => {
            event.preventDefault();
            saveCustomIp();
          }}
          onClear={() =>
            reconnectAfterCustomIpChange(customIpPeer, undefined)
          }
          onClose={() => {
            setCustomIpPeer(undefined);
            setCustomIpError(undefined);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          initialName={deviceName}
          theme={theme}
          language={i18n.language.startsWith("zh") ? "zh" : "en"}
          deviceId={identity?.device.deviceId}
          iceSettings={iceSettings}
          maxActivePeerClients={maxActivePeerClients}
          resources={resourceMessages}
          onPreviewResource={(message) =>
            void openResourcePreview(message)
          }
          onDownloadResource={(message) =>
            void downloadStoredResource(message)
          }
          onDeleteResource={(message) =>
            void deleteStoredResource(message)
          }
          onClearResources={() => void clearStoredResources()}
          onSave={(
            name,
            nextTheme,
            language,
            nextIceSettings,
            nextMaxActivePeerClients,
          ) => {
            const normalizedIceSettings =
              normalizeIceServerSettings(nextIceSettings);
            saveIceServerSettings(normalizedIceSettings);
            setIceSettings(normalizedIceSettings);
            setMaxActivePeerClients(
              saveMaxActivePeerClients(nextMaxActivePeerClients),
            );
            setAllIceServers(
              rtcIceServersFromSettings(normalizedIceSettings),
              Boolean(normalizedIceSettings.relayOnly),
            );
            if (client && !client.isOnline && navigator.onLine) {
              void client.probePublicAddresses();
            }
            setTheme(nextTheme);
            if (name.trim() && name.trim() !== deviceName) {
              const normalizedName = name.trim();
              setAllDeviceNames(normalizedName);
              setDeviceName(normalizedName);
            }
            void i18n.changeLanguage(language);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {resourceViewer && (
        <ResourceViewerDialog
          viewer={resourceViewer}
          onClose={closeResourceViewer}
          onPreviewFailed={() =>
            setResourceViewer((current) =>
              current ? { ...current, previewFailed: true } : current,
            )
          }
          onDownload={() =>
            void downloadStoredResource(resourceViewer.message)
          }
          onDelete={() =>
            void deleteStoredResource(resourceViewer.message)
          }
        />
      )}

      {conversationRetry && (
        <ConversationRetryOverlay
          retry={conversationRetry}
          peerName={retryPeer?.name}
          status={
            peerRuntimes[conversationRetry.peerId]?.status ||
            (navigator.onLine ? "offline" : "network_offline")
          }
          secondsRemaining={retrySecondsRemaining}
          customIp={Boolean(retryPeer?.customIp)}
          onRetryNow={retryConversationImmediately}
          onCancel={cancelConversationRetry}
          onEditCustomIp={() => {
            if (!retryPeer) return;
            cancelConversationRetry();
            setCustomIpPeer(retryPeer);
            setCustomIpDraft(retryPeer.customIp || "");
            setCustomIpError(undefined);
          }}
        />
      )}

      {turnstileRequest && apiConfig?.turnstileSiteKey && (
        <TurnstileDialog
          siteKey={apiConfig.turnstileSiteKey}
          onToken={finishHumanVerification}
          onCancel={failHumanVerification}
          onError={failHumanVerification}
        />
      )}

      {notice && <Toast notice={notice} />}
    </div>
  );
}
