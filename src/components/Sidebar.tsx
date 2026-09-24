import { publicKeyLabel } from "../lib/publicKeyLabel";
import { PeerAvatar } from "./Avatar";
import { useWalletMode } from "../hooks/useAvatars";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { PinIcon } from "./PinIcon";
import { findMoney } from "../lib/money";
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { NewGroupDialog } from "./NewGroupDialog";
import { groupPath, groupReadAt, groupRouteId } from "../lib/groups";
import { useIsMobile } from "../hooks/useIsMobile";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { JoinDialog } from "./JoinDialog";
import { useBackgroundPoller } from "../hooks/useBackgroundPoller";
import { useI18n } from "../contexts/I18nContext";
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

/** A pasted invoice or token reads as what it is, not as its first characters. */
function previewText(text: string): string {
  const money = findMoney(text);
  if (!money) return text;
  if (money.type === "cashu") return "⚡ Ecash";
  if (money.type === "lnurl") return `⚡ ${money.destination.kind === "address" ? "Lightning address" : "LNURL"} · ${money.destination.text}`;
  return money.invoice.amountSat === null ? "⚡ Lightning invoice" : `⚡ Lightning invoice · ${money.invoice.amountSat.toLocaleString()} sats`;
}

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/** A private group, or an invitation to one, in the chat list. */
function GroupRow({ group, active, onOpen }: { group: GroupView; active: boolean; onOpen(): void }) {
  const [busy, setBusy] = useState(false);
  const invitation = group.invitation;
  const unread = !active && !invitation && group.lastMessageAt > groupReadAt(group.id);
  const answer = async (method: "acceptGroupInvitation" | "declineGroupInvitation") => {
    setBusy(true);
    try { await engine.call(method, { groupId: group.id }); } catch { /* the row says what state it is in */ } finally { setBusy(false); }
  };
  const status = invitation ? (invitation.accepted ? "Joining…" : `Invited by ${invitation.contact || "a contact"} · ${invitation.members} member${invitation.members === 1 ? "" : "s"}`)
    : group.status !== "active" ? group.statusReason ?? group.status : `${group.members.length} member${group.members.length === 1 ? "" : "s"}`;
  return (
    <div data-testid="group-row" data-group={group.id} onClick={onOpen}
      className={`flex items-center gap-3 px-3 py-3 transition-colors group cursor-pointer ${active ? "bg-surface-hover" : "hover:bg-surface-alt"}`}>
      <div className={`relative w-12 h-12 rounded-full flex items-center justify-center shrink-0 text-accent ${active ? "bg-surface-alt" : "bg-surface-hover"}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
        {unread && <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent" />}
      </div>
      <div className="flex-1 min-w-0 py-1">
        <span className={`text-[15px] truncate block ${unread ? "text-text-primary font-semibold" : "text-text-primary"}`}>{group.name}</span>
        <p className="text-[12px] truncate m-0 text-text-muted">{status}</p>
        {invitation && !invitation.accepted && <div className="mt-1.5 flex gap-2">
          <button disabled={busy} data-testid="group-accept" onClick={e => { e.stopPropagation(); void answer("acceptGroupInvitation"); }} className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">Accept</button>
          <button disabled={busy} data-testid="group-decline" onClick={e => { e.stopPropagation(); void answer("declineGroupInvitation"); }} className="rounded-lg px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-40">Decline</button>
        </div>}
      </div>
    </div>
  );
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 420;
/** What the page beside the list always keeps, however wide the list is dragged: a phone's width, about. */
const MIN_PAGE_WIDTH = 320;

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const walletMode = useWalletMode();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
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
      const newWidth = Math.min(MAX_WIDTH, window.innerWidth - MIN_PAGE_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
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

  const formatTime = (ts: number) => {
    const now = Date.now();
    const diff = now - ts;
    const minutes = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    return new Date(ts).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });
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
      className={`relative flex flex-col bg-sidebar-bg ${isMobile ? "flex-1 min-w-0" : "sidebar-desktop border-r border-border shrink-0"}`}
      style={isMobile ? undefined : { width: sidebarWidth, minWidth: MIN_WIDTH, maxWidth: `min(${MAX_WIDTH}px, 100vw - ${MIN_PAGE_WIDTH}px)` }}
    >
      {/* Header */}
      <div className="sidebar-header h-14 header-safe shrink-0 flex items-center justify-between px-4 bg-panel-header">
        <Link to="/" aria-label="Go home" title="Go home" className="sidebar-home flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <svg width="28" height="28" viewBox="0 0 64 64" className="shrink-0">
            <g transform="translate(12, 8)">
              <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-accent"/>
              <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
              <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
            </g>
          </svg>
          <span className="sidebar-wordmark whitespace-nowrap text-accent font-bold text-base tracking-tight">
            GHOSTLY
          </span>
        </Link>
        {/* Wherever the app is, it says when its wallets are on test networks: nothing there is money. */}
        {walletMode === "testnet" && (
          <Link to="/wallet" data-testid="testnet-badge" title="Wallets are on test networks: test coins, worth nothing"
            className="mr-auto ml-2 shrink-0 rounded-full border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-500 hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
            Testnet
          </Link>
        )}
        <div className="grid shrink-0 grid-cols-3 items-stretch gap-1 whitespace-nowrap" data-testid="sidebar-chat-actions">
          <button onClick={() => navigate(chatPath(createPairedChat()))} aria-label={t("sidebar.startChat")} title={t("sidebar.newChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg bg-accent p-2 text-sm font-semibold text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/></svg><span className="sidebar-action-label">{t("sidebar.new")}</span></button>
          <button onClick={() => setShowNewChat(true)} aria-label={t("join.submit")} title={t("sidebar.joinChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg p-2 text-sm font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9l-5 3v-6 M2 12h12 M10 8l4 4-4 4"/></svg><span className="sidebar-action-label">{t("sidebar.join")}</span></button>
          <button onClick={() => setShowNewGroup(true)} aria-label="New group" title="New group" data-testid="new-group" className="sidebar-header-action inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg p-2 text-sm font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M16 11h6" /></svg><span className="sidebar-action-label">Group</span></button>
        </div>
      </div>
      <UpdateBanner />
      {showNewGroup && <NewGroupDialog onClose={() => setShowNewGroup(false)} onCreated={id => { setShowNewGroup(false); navigate(groupPath(id)); }} />}
      {showNewChat && <JoinDialog onClose={() => setShowNewChat(false)} onJoin={keys => {setShowNewChat(false); navigate(chatPath(ensureSession(keys))); refreshSessions();}} />}

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
          <GroupRow key={group.id} group={group} active={activeGroupId === group.id} onOpen={() => { navigate(groupPath(group.id)); setConfirmDeleteId(null); }} />
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
          const peerLabel = peerName || t("common.anonymous");
          const unread = isActive ? 0 : getUnreadCount(session);
          const isCreator = !!getInviteCode(session.id);

          return (
            <div
              key={session.id}
              onClick={() => {
                {
                  markSessionAsRead(session.id);
                  navigate(path);
                  setConfirmDeleteId(null);
                }
              }}
              className={`flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors group ${
                isActive
                  ? "bg-surface-hover"
                  : "hover:bg-surface-alt"
              }`}
            >
              {/* Avatar */}
              <div className={`relative w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${
                isActive ? "bg-surface-alt" : "bg-surface-hover"
              }`}>
                <PeerAvatar peerPubKey={session.peerPubKeyB64} label={peerLabel} testId="chat-row-avatar" />
                {syncingSessions.has(session.id) && (
                  <span className="absolute -top-1 -left-1 w-5 h-5 flex items-center justify-center z-10">
                    <svg
                      className="animate-ghost-boo w-5 h-5"
                      viewBox="0 0 64 64"
                    >
                      <g transform="translate(12, 6)">
                        <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-text-muted"/>
                        <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
                        <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
                      </g>
                    </svg>
                  </span>
                )}
                {unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-accent text-[#111b21] text-[10px] font-bold rounded-full px-1">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
                {isCreator && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] flex items-center justify-center rounded-full text-[9px] bg-accent text-[#111b21] z-10 group/star">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                    </svg>
                    <span className="absolute top-1/2 -translate-y-1/2 left-full ml-2 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover/star:opacity-100 transition-opacity pointer-events-none shadow-lg border border-border">
                      You created this chat
                    </span>
                  </span>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 border-b border-transparent py-1">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="min-w-0 flex-1">
                    <span className={`text-[15px] truncate block ${isAnonymous ? "text-text-muted/60 italic" : unread > 0 ? "text-text-primary font-semibold" : "text-text-primary"}`}>
                      {peerLabel}
                    </span>
                    <span className="text-[11px] text-text-muted/60 font-mono whitespace-nowrap block">
                      {peerKey}
                    </span>
                  </div>
                  <span className={`text-xs shrink-0 ${unread > 0 ? "text-accent font-medium" : "text-text-muted"}`}>
                    {formatTime(session.lastSyncAt ?? session.createdAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <p className={`text-[13px] truncate m-0 ${unread > 0 ? "text-text-secondary font-medium" : "text-text-muted"}`}>
                      {lastMsg ? (
                        <>
                          {lastMsg.sender === "me" && (
                            <span className="text-text-secondary">
                              <svg
                                width="16"
                                height="11"
                                viewBox="0 0 16 11"
                                fill="none"
                                className="inline mr-0.5 -mt-0.5"
                              >
                                <path
                                  d="M11 1L4.125 8.5L1 5.5"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                <path
                                  d="M15 1L8.125 8.5L7 7.3"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                          )}
                          {previewText(lastMsg.text)}
                        </>
                      ) : (
                        <span className="italic">No messages</span>
                      )}
                    </p>
                  <div className="flex items-center gap-1 shrink-0">
                    {<button
                      title={isSessionPinned(session.id) ? "Unpin chat" : "Pin chat"}
                      aria-label={isSessionPinned(session.id) ? "Unpin chat" : "Pin chat"}
                      aria-pressed={isSessionPinned(session.id)}
                      onClick={e => { e.stopPropagation(); setSessionPinned(session.id, !isSessionPinned(session.id)); }}
                      className={`flex min-w-7 items-center justify-center rounded p-1 max-md:p-2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 ${isSessionPinned(session.id) ? "opacity-100 text-accent bg-accent/15" : "opacity-0 text-text-muted"}`}>
                      <PinIcon active={isSessionPinned(session.id)} />
                    </button>}
                    {unread > 0 && (
                      <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                    )}
                    {(
                      <button
                        onClick={(e) => handleDelete(session.id, e)}
                        className="max-md:hidden opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-1 text-text-muted hover:text-danger transition-all cursor-pointer"
                        title={t("sidebar.deleteChat")}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {confirmDeleteId && <DeleteChatDialog
        name={(() => { const target=sessions.find(s=>s.id===confirmDeleteId); return `${target?.label || target?.nick || t("common.anonymous")} · ${publicKeyLabel(target?.peerPubKeyB64 ?? confirmDeleteId)}`; })()}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => { const id=confirmDeleteId; deleteSession(id); setConfirmDeleteId(null); refreshSessions(); window.dispatchEvent(new Event("session-updated")); if(activeSessionId===id) navigate("/"); }} />}
      {!isMobile && <AccountBar />}

      {/* Resize Handle */}
      <div
        data-testid="sidebar-resize"
        onMouseDown={handleResizeStart}
        className="max-md:hidden absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}
