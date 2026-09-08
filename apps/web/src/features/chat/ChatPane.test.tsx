import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPane, type ChatPaneProps } from "./ChatPane";
import { SAVED_CONVERSATION_ID } from "../../store";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../messages/MessageList", () => ({ MessageList: () => null }));

function render(overrides: Partial<ChatPaneProps> = {}) {
  const noop = vi.fn();
  const props: ChatPaneProps = {
    visibleOnMobile: true, selectedId: "peer", selectedPeer: { deviceId: "peer", name: "Peer" } as ChatPaneProps["selectedPeer"],
    selectedMessages: [], ownDeviceId: "self", onlineForSelection: false,
    connectionStatus: "offline", connectionDetail: "peerOffline", retryAvailable: true,
    connectionRouteSummary: "P2P", peerMenuOpen: false, peerMenuRef: { current: null },
    activePinnedMessage: undefined, pinnedMessages: [], pinnedCursor: 0, progress: {},
    messageJumpTarget: undefined, replyingTo: undefined, draft: "unsent draft", inputRef: { current: null },
    onBack: noop, onTogglePeerMenu: noop, onDeleteConversation: noop, onOpenPinnedMessage: noop,
    onTogglePin: noop, onDeleteMessage: noop, onOpenFile: noop, onStopFile: noop,
    onCopyMessage: noop, onReply: noop, onJumpToMessage: noop, onCancelReply: noop,
    onSelectFile: noop, onDraftChange: noop, onComposerKeyDown: noop, onComposerPaste: noop, onSend: noop,
    onRetryConnection: noop, onCancelConnection: noop,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ChatPane, props));
}

describe("conversation composer states", () => {
  it.each(["offline", "failed", "network_offline"] as const)("replaces the entire %s composer with retry", connectionStatus => {
    const html = render({ connectionStatus });
    expect(html).toContain("retry.retryNow");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('aria-label="chooseFile"');
    expect(html).not.toContain('aria-label="sendMessage"');
    expect(html).not.toContain('role="dialog"');
    if (connectionStatus === "network_offline") expect(html).toContain('disabled=""');
  });

  it("shows cancellable progress inline while connecting", () => {
    const html = render({ connectionStatus: "waiting", connectionDetail: "waitingForKnownPeer" });
    expect(html).toContain("retry.registered");
    expect(html).toContain("retry.cancel");
    expect(html).not.toContain("retry.retryNow");
    expect(html).not.toContain("<textarea");
  });

  it("restores the composer with its draft after connection", () => {
    const html = render({ connectionStatus: "online", onlineForSelection: true });
    expect(html).toContain("<textarea");
    expect(html).toContain("unsent draft");
    expect(html).not.toContain("retry.retryNow");
  });

  it("leaves saved messages writable without a network", () => {
    const html = render({ selectedId: SAVED_CONVERSATION_ID, connectionStatus: "network_offline", retryAvailable: false });
    expect(html).toContain("<textarea");
    expect(html).not.toContain('disabled=""');
  });
});
