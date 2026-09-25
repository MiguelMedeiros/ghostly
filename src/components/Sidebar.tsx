import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { useWalletMode } from "../hooks/useAvatars";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { ChatRow, GroupRow } from "./ChatRow";
import { formatListTime } from "../lib/chatList";
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { NewGroupDialog } from "./NewGroupDialog";
import { groupPath, groupRouteId } from "../lib/groups";
import { useIsMobile } from "../hooks/useIsMobile";
import { Menu, MenuItem } from "./Menu";
import { useLocation, Link } from "react-router-dom";
import { JoinDialog } from "./JoinDialog";
import { useBackgroundPoller } from "../hooks/useBackgroundPoller";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { AccountBar } from "./AccountBar";
import { UpdateBanner } from "./UpdateBanner";
import {
  listSessions,
  isSessionPinned,
  setSessionPinned,
  deleteSession,
  getUnreadCount,
  markSessionAsRead,
  ensureSession,
  getInviteCode,
} from "../lib/storage";
import { createPairedChat } from "../lib/pairedChat";
import { chatPath } from "../lib/url";
import type { ChatSession } from "../lib/types";
import { useAppNavigation } from "../hooks/useAppNavigation";

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 420;
/** What the page beside the list always keeps, however wide the list is dragged: a phone's width, about. */
const MIN_PAGE_WIDTH = 320;

export function Sidebar() {
  const nav = useAppNavigation();
  const location = useLocation();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const walletMode = useWalletMode();
  const density = useSettings().settings.chatListDensity;
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const closeNewMenu = () => setNewMenuOpen(false);
  const groups = useSyncExternalStore(subscribeEngine, engineSnapshot)?.groups ?? [];
  const activeGroupId = groupRouteId(location.pathname);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Right to left, the sidebar sits on the right and its edge is dragged from there.
      const edge = document.documentElement.dir === "rtl" ? window.innerWidth - ev.clientX : ev.clientX;
      const newWidth = Math.min(MAX_WIDTH, window.innerWidth - MIN_PAGE_WIDTH, Math.max(MIN_WIDTH, edge));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const currentChatPath = location.pathname.startsWith("/chat")
    ? location.pathname
    : null;

  const activeSessionId = (() => {
    if (!currentChatPath) return null;
    const id = decodeURIComponent(currentChatPath.replace("/chat/", ""));
    return id && !id.includes("/") ? id : null;
  })();


  const { syncingSessions } = useBackgroundPoller(activeSessionId);

  const refreshSessions = useCallback(() => {
    const updated = listSessions();

    setSessions(updated);
    // A chat deleted elsewhere takes its pending "Delete?" with it.
    setConfirmDeleteId((id) => (id && !updated.some((s) => s.id === id) ? null : id));
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 3000);
    
    const handleSessionUpdate = () => refreshSessions();
    window.addEventListener("session-updated", handleSessionUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener("session-updated", handleSessionUpdate);
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (activeSessionId) markSessionAsRead(activeSessionId);
  }, [activeSessionId, sessions]);

  const handleDelete = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setConfirmDeleteId(sessionId);
  };

  const filtered = sessions.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (s.label?.toLowerCase().includes(q)) return true;
    if (s.nick?.toLowerCase().includes(q)) return true;
    if (s.peerPubKeyB64.toLowerCase().includes(q)) return true;
    return s.messages.some((m) => m.text.toLowerCase().includes(q));
  });

  return (
    <div
      data-testid="sidebar"
      className={`relative flex flex-col bg-sidebar-bg ${isMobile ? "flex-1 min-w-0" : "sidebar-desktop border-e border-border shrink-0"}`}
      style={isMobile ? undefined : { width: sidebarWidth, minWidth: MIN_WIDTH, maxWidth: `min(${MAX_WIDTH}px, 100vw - ${MIN_PAGE_WIDTH}px)` }}
    >
      {/* Header */}
      <div className="sidebar-header h-14 header-safe shrink-0 flex items-center justify-between px-4 bg-panel-header">
        {/* The brand; in Testnet a small badge sits under the wordmark, out of the header's row, so it never takes the buttons' width. */}
        <div className="relative flex shrink-0 items-center">
        <Link to="/" onClick={(e) => { e.preventDefault(); nav.home(); }} aria-label="Go home" title="Go home" className="sidebar-home flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <svg width="28" height="28" viewBox="0 0 64 64" className="shrink-0">
            <g transform="translate(12, 8)">
              <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-accent"/>
              <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
              <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
            </g>
          </svg>
          <span className={`sidebar-wordmark whitespace-nowrap text-accent font-bold text-base tracking-tight ${walletMode === "testnet" ? "-translate-y-[7px]" : ""}`}>
            GHOSTLY
          </span>
        </Link>
        {/* Wherever the app is, it says when its wallets are on test networks: nothing there is money. */}
        {walletMode === "testnet" && (
          <Link to="/wallet" onClick={(e) => { e.preventDefault(); nav.place("/wallet"); }} data-testid="testnet-badge" title="Wallets are on test networks: test coins, worth nothing"
            className="absolute start-9 top-[calc(50%+3px)] rounded-full border border-amber-500/60 bg-amber-500/15 px-1.5 py-px text-[9px] font-bold uppercase leading-[12px] tracking-wider text-amber-500 hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
            Testnet
          </Link>
        )}
        </div>
        <div className="grid shrink-0 grid-cols-2 items-stretch gap-1 whitespace-nowrap" data-testid="sidebar-chat-actions">
          {/* New: one click is a chat, as always; the arrow beside it also offers a group. */}
          <div ref={newMenuRef} role="group" aria-label={t("sidebar.new")} data-testid="sidebar-new" className="sidebar-new-split relative flex min-w-0">
            <button onClick={() => nav.conversation(chatPath(createPairedChat()))} aria-label={t("sidebar.startChat")} title={t("sidebar.newChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 flex-1 items-center justify-center gap-1 rounded-s-lg bg-accent p-2 text-sm font-semibold text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/></svg><span className="sidebar-action-label">{t("sidebar.new")}</span></button>
            <button onClick={() => setNewMenuOpen(open => !open)} aria-haspopup="true" aria-expanded={newMenuOpen} aria-controls="sidebar-new-menu" aria-label={t("sidebar.newMenu.label")} title={t("sidebar.newMenu.label")} data-testid="sidebar-new-more"
              className="inline-flex min-h-10 w-6 shrink-0 items-center justify-center rounded-e-lg border-s border-panel-header/25 bg-accent text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${newMenuOpen ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <Menu id="sidebar-new-menu" testId="sidebar-new-menu" open={newMenuOpen} onClose={closeNewMenu} anchorRef={newMenuRef}>
              <MenuItem onClick={() => { closeNewMenu(); nav.conversation(chatPath(createPairedChat())); }} hint={t("sidebar.newMenu.chatHint")}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/></svg>}>
                {t("sidebar.newMenu.chat")}
              </MenuItem>
              <MenuItem testId="new-group" onClick={() => { closeNewMenu(); setShowNewGroup(true); }} hint={t("sidebar.newMenu.groupHint")}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M16 11h6" /></svg>}>
                {t("sidebar.newMenu.group")}
              </MenuItem>
            </Menu>
          </div>
          <button onClick={() => setShowNewChat(true)} aria-label={t("join.submit")} title={t("sidebar.joinChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg p-2 text-sm font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9l-5 3v-6 M2 12h12 M10 8l4 4-4 4"/></svg><span className="sidebar-action-label">{t("sidebar.join")}</span></button>
        </div>
      </div>
      <UpdateBanner />
      {showNewGroup && <NewGroupDialog onClose={() => setShowNewGroup(false)} onCreated={id => { setShowNewGroup(false); nav.conversation(groupPath(id), { share: "created" }); }} />}
      {showNewChat && <JoinDialog onClose={() => setShowNewChat(false)} onJoin={keys => {setShowNewChat(false); nav.conversation(chatPath(ensureSession(keys))); refreshSessions();}}
        onJoinGroup={async link => { const { groupId } = await engine.call("joinGroupByLink", { link }); setShowNewChat(false); nav.conversation(groupPath(groupId)); }} />}

      {/* Search */}
      <div className="px-3 py-2 bg-sidebar-bg">
        <div className="flex items-center gap-3 bg-search-bg rounded-lg px-3 py-1.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-text-muted shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("sidebar.searchPlaceholder")}
            className="flex-1 bg-transparent border-none text-sm text-text-primary placeholder-text-muted focus:outline-none py-1"
          />
        </div>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {groups.filter(g => !search || g.name.toLowerCase().includes(search.toLowerCase())).map(group => (
          <GroupRow key={group.id} group={group} density={density} active={activeGroupId === group.id} onOpen={() => { nav.conversation(groupPath(group.id)); setConfirmDeleteId(null); }} />
        ))}
        {filtered.length === 0 && sessions.length === 0 && groups.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="text-text-muted mb-4 animate-ghost-boo">
              <svg className="w-12 h-12 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
                <circle cx="9" cy="9" r="1.5" fill="#111b21"/>
                <circle cx="15" cy="9" r="1.5" fill="#111b21"/>
              </svg>
            </div>
            <p className="text-text-secondary text-sm mb-1">{t("sidebar.quiet")}</p>
            <p className="text-text-muted text-xs">{t("sidebar.quietHint")}</p>
          </div>
        )}

        {filtered.length === 0 && sessions.length > 0 && (
          <div className="flex items-center justify-center py-10 px-8">
            <p className="text-text-muted text-sm">No results found</p>
          </div>
        )}

        {filtered.map((session) => {
          const lastMsg = session.messages[session.messages.length - 1];
          const path = chatPath(session.id);
          const isActive = activeSessionId === session.id;

          const peerName = session.label || session.nick;
          const peerKey = publicKeyLabel(session.peerPubKeyB64);
          const isAnonymous = !peerName;
          const peerLabel = peerName || t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) });
          const unread = isActive ? 0 : getUnreadCount(session);
          const isCreator = !!getInviteCode(session.id);

          return (
            <ChatRow
              key={session.id}
              density={density}
              active={isActive}
              label={peerLabel}
              named={!isAnonymous}
              keyLabel={peerKey}
              peerPubKey={session.peerPubKeyB64}
              lastMessage={lastMsg}
              time={formatListTime(session.lastSyncAt ?? session.createdAt)}
              unread={unread}
              pinned={isSessionPinned(session.id)}
              syncing={syncingSessions.has(session.id)}
              creator={isCreator}
              onOpen={() => { markSessionAsRead(session.id); nav.conversation(path); setConfirmDeleteId(null); }}
              onTogglePin={() => setSessionPinned(session.id, !isSessionPinned(session.id))}
              onDelete={(e) => handleDelete(session.id, e)}
              deleteLabel={t("sidebar.deleteChat")}
            />
          );
        })}
      </div>

      {confirmDeleteId && <DeleteChatDialog
        name={(() => { const target=sessions.find(s=>s.id===confirmDeleteId); return `${target?.label || target?.nick || t("common.unnamedContact", { key: contactTag(target?.peerPubKeyB64 ?? confirmDeleteId) })} · ${publicKeyLabel(target?.peerPubKeyB64 ?? confirmDeleteId)}`; })()}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => { const id=confirmDeleteId; deleteSession(id); setConfirmDeleteId(null); refreshSessions(); window.dispatchEvent(new Event("session-updated")); if(activeSessionId===id) nav.home(); }} />}
      {!isMobile && <AccountBar />}

      {/* Resize Handle */}
      <div
        data-testid="sidebar-resize"
        onMouseDown={handleResizeStart}
        className="max-md:hidden absolute top-0 end-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}
