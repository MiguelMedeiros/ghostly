import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { usePkarr } from "../hooks/usePkarr";
import { useBackgroundPoller } from "../hooks/useBackgroundPoller";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import {
  listSessions,
  deleteSession,
  deleteAllSessions,
  getUnreadCount,
  markSessionAsRead,
  generateSessionId,
  saveInviteCode,
  getInviteCode,
} from "../lib/storage";
import type { ChatSession } from "../lib/types";

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1046, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch {
    // audio not available
  }
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 420;

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { createDrop } = usePkarr();
  const { t } = useI18n();
  const { settings } = useSettings();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const prevTotalMsgsRef = useRef<Record<string, number>>({});
  const lastNotifRef = useRef<number>(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const initialSyncCompleteRef = useRef(false);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isResizingRef = useRef(false);
  const newChatPanelRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
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

  const getSessionPath = (s: ChatSession) =>
    `/chat/${s.mySeedB64}/${s.peerPubKeyB64}/${s.encKeyB64}`;

  const activeSessionId = (() => {
    if (!currentChatPath) return null;
    const parts = currentChatPath.replace("/chat/", "").split("/");
    if (parts.length >= 2) return generateSessionId(parts[0], parts[1]);
    return null;
  })();

  activeSessionIdRef.current = activeSessionId;

  const { syncingSessions, initialSyncComplete } =
    useBackgroundPoller(activeSessionId);

  useEffect(() => {
    if (initialSyncComplete && !initialSyncCompleteRef.current) {
      const updated = listSessions();
      const baseline: Record<string, number> = {};
      for (const s of updated) {
        baseline[s.id] = s.messages.filter(
          (m) => m.sender === "peer",
        ).length;
      }
      prevTotalMsgsRef.current = baseline;
      initialSyncCompleteRef.current = true;
    }
  }, [initialSyncComplete]);

  const refreshSessions = useCallback(() => {
    const updated = listSessions();

    const prev = prevTotalMsgsRef.current;
    let hasNewPeerMsg = false;
    const currentActive = activeSessionIdRef.current;
    for (const s of updated) {
      const peerMsgCount = s.messages.filter((m) => m.sender === "peer").length;
      const prevCount = prev[s.id] ?? peerMsgCount;
      if (peerMsgCount > prevCount && s.id !== currentActive) {
        hasNewPeerMsg = true;
      }
      prev[s.id] = peerMsgCount;
    }
    prevTotalMsgsRef.current = prev;

    const now = Date.now();
    if (
      hasNewPeerMsg &&
      now - lastNotifRef.current > 3_000 &&
      initialSyncCompleteRef.current &&
      settings.notifications.soundEnabled
    ) {
      lastNotifRef.current = now;
      playNotificationSound();
    }

    setSessions(updated);
  }, [settings.notifications.soundEnabled]);

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

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showNewChat &&
        newChatPanelRef.current &&
        !newChatPanelRef.current.contains(e.target as Node)
      ) {
        setShowNewChat(false);
        setJoinError("");
        setInviteInput("");
      }
    };
    if (showNewChat) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showNewChat]);

  const handleCreate = async () => {
    const drop = await createDrop();
    const sessionId = generateSessionId(drop.seedA, drop.pubKeyB);
    saveInviteCode(sessionId, drop.inviteCode);
    setShowNewChat(false);
    navigate(`/chat/${drop.seedA}/${drop.pubKeyB}/${drop.encKey}`);
    setTimeout(refreshSessions, 500);
  };

  const handleJoinWithInput = (input: string) => {
    setJoinError("");
    const trimmed = input.trim();
    if (!trimmed) return;

    let chatPath: string | null = null;

    try {
      const url = new URL(trimmed);
      const hash = url.hash;
      if (hash && hash.includes("/chat/")) {
        chatPath = hash.replace(/^#/, "");
      }
    } catch {
      // not a valid URL — try other formats
    }

    if (!chatPath && trimmed.includes("/chat/")) {
      const idx = trimmed.indexOf("/chat/");
      chatPath = trimmed.slice(idx);
    }

    if (!chatPath) {
      const cleaned = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
      const segments = cleaned.split("/");
      if (segments.length === 3 && segments.every((s) => s.length > 0)) {
        chatPath = `/chat/${cleaned}`;
      }
    }

    if (chatPath) {
      setShowNewChat(false);
      setInviteInput("");
      navigate(chatPath);
      setTimeout(refreshSessions, 500);
    } else {
      setJoinError("Invalid invite code");
    }
  };

  const handleDelete = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (confirmDeleteId === sessionId) {
      deleteSession(sessionId);
      setConfirmDeleteId(null);
      refreshSessions();
      if (activeSessionId === sessionId) {
        navigate("/");
      }
    } else {
      setConfirmDeleteId(sessionId);
    }
  };

  const handleDeleteAll = () => {
    if (confirmDeleteAll) {
      deleteAllSessions();
      setConfirmDeleteAll(false);
      refreshSessions();
      navigate("/");
    } else {
      setConfirmDeleteAll(true);
    }
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
    if (s.nick?.toLowerCase().includes(q)) return true;
    if (s.peerPubKeyB64.toLowerCase().includes(q)) return true;
    return s.messages.some((m) => m.text.toLowerCase().includes(q));
  });

  return (
    <div
      className="relative flex flex-col border-r border-border bg-sidebar-bg shrink-0"
      style={{ width: sidebarWidth, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
    >
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 bg-panel-header">
        <div className="flex items-center gap-2">
          <svg width="28" height="28" viewBox="0 0 64 64" className="shrink-0">
            <g transform="translate(12, 8)">
              <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-accent"/>
              <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
              <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
            </g>
          </svg>
          <span className="text-accent font-bold text-base tracking-tight">
            GHOSTLY
          </span>
        </div>
        <button
          onClick={() => {
            setShowNewChat(!showNewChat);
            setJoinError("");
            setInviteInput("");
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-[#111b21] rounded-lg hover:bg-accent-hover transition-colors cursor-pointer font-semibold text-sm"
          title={t("sidebar.newChat")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{t("sidebar.newChat").split(" ")[0]}</span>
        </button>
      </div>

      {/* New Chat Panel */}
      {showNewChat && (
        <div ref={newChatPanelRef} className="border-b border-border bg-surface-alt p-4 space-y-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-xs font-bold uppercase tracking-wider">
              {t("sidebar.newChat")}
            </span>
            <button
              onClick={() => {
                setShowNewChat(false);
                setJoinError("");
                setInviteInput("");
              }}
              className="text-text-muted hover:text-text-primary transition-colors cursor-pointer text-lg leading-none"
            >
              &times;
            </button>
          </div>

          <div className="space-y-3">
            <p className="text-text-muted text-xs">
              Paste an invite code to join an existing chat:
            </p>
            <div className="flex items-center bg-input-bg rounded-lg overflow-hidden border border-border focus-within:border-accent transition-colors">
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => {
                  setInviteInput(e.target.value);
                  setJoinError("");
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  const text = e.clipboardData.getData("text");
                  if (text && text.trim()) {
                    setInviteInput(text);
                    handleJoinWithInput(text);
                  }
                }}
                onKeyDown={(e) => e.key === "Enter" && inviteInput.trim() && handleJoinWithInput(inviteInput)}
                placeholder="Invite code..."
                className="flex-1 bg-transparent border-none px-3 py-2.5 text-xs text-text-primary placeholder-text-muted focus:outline-none font-mono"
              />
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text && text.trim()) {
                      setInviteInput(text);
                      handleJoinWithInput(text);
                    }
                  } catch {
                    // clipboard access denied
                  }
                }}
                className="px-3 py-2.5 bg-accent hover:bg-accent-hover text-[#111b21] font-semibold text-xs transition-colors cursor-pointer flex items-center gap-1.5"
                title="Paste and join"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Paste
              </button>
            </div>
            {joinError && (
              <p className="text-danger text-xs">{joinError}</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-text-muted text-[10px] uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <button
            onClick={handleCreate}
            className="w-full py-2.5 bg-accent text-[#111b21] rounded-lg font-bold text-xs tracking-wider uppercase hover:bg-accent-hover transition-colors cursor-pointer"
          >
            {t("home.createChat")}
          </button>
        </div>
      )}

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
        {filtered.length === 0 && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="text-text-muted mb-4 animate-ghost-boo">
              <svg className="w-12 h-12 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
                <circle cx="9" cy="9" r="1.5" fill="#111b21"/>
                <circle cx="15" cy="9" r="1.5" fill="#111b21"/>
              </svg>
            </div>
            <p className="text-text-secondary text-sm mb-1">It's quiet here...</p>
            <p className="text-text-muted text-xs">Time to haunt someone! 👻</p>
          </div>
        )}

        {filtered.length === 0 && sessions.length > 0 && (
          <div className="flex items-center justify-center py-10 px-8">
            <p className="text-text-muted text-sm">No results found</p>
          </div>
        )}

        {filtered.map((session) => {
          const lastMsg = session.messages[session.messages.length - 1];
          const path = getSessionPath(session);
          const isActive = currentChatPath === path;
          const isConfirming = confirmDeleteId === session.id;
          const peerName = session.label || session.nick;
          const peerKey = session.peerPubKeyB64.slice(0, 12) + "...";
          const isAnonymous = !peerName;
          const peerLabel = peerName || "Anonymous";
          const unread = isActive ? 0 : getUnreadCount(session);
          const isCreator = !!getInviteCode(session.id);

          return (
            <div
              key={session.id}
              onClick={() => {
                if (!isConfirming) {
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
                <span className={`text-lg ${isAnonymous ? "text-text-muted/50" : "text-text-muted"}`}>
                  {peerLabel.charAt(0).toUpperCase()}
                </span>
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
              <div className="flex-1 min-w-0 border-b border-border py-1">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="min-w-0 flex-1">
                    <span className={`text-[15px] truncate block ${isAnonymous ? "text-text-muted/60 italic" : unread > 0 ? "text-text-primary font-semibold" : "text-text-primary"}`}>
                      {peerLabel}
                    </span>
                    <span className="text-[11px] text-text-muted/60 font-mono truncate block">
                      {peerKey}
                    </span>
                  </div>
                  <span className={`text-xs shrink-0 ${unread > 0 ? "text-accent font-medium" : "text-text-muted"}`}>
                    {formatTime(session.lastSyncAt ?? session.createdAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  {isConfirming ? (
                    <div className="flex items-center gap-1 animate-fade-in">
                      <button
                        onClick={(e) => handleDelete(session.id, e)}
                        className="px-2 py-0.5 text-[10px] font-bold text-danger bg-danger/20 border border-danger/30 rounded hover:bg-danger/30 transition-colors cursor-pointer"
                      >
                        {t("common.delete")}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setConfirmDeleteId(null);
                        }}
                        className="px-2 py-0.5 text-[10px] font-bold text-text-muted bg-surface-hover border border-border rounded hover:text-text-secondary transition-colors cursor-pointer"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  ) : (
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
                          {lastMsg.text}
                        </>
                      ) : (
                        <span className="italic">No messages</span>
                      )}
                    </p>
                  )}
                  <div className="flex items-center gap-1 shrink-0">
                    {unread > 0 && !isConfirming && (
                      <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                    )}
                    {!isConfirming && (
                      <button
                        onClick={(e) => handleDelete(session.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-danger transition-all cursor-pointer"
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

      {/* Footer */}
      <div className="border-t border-border bg-sidebar-bg">
        {/* Delete All Section */}
        {sessions.length > 0 && (
          <div className="p-3 border-b border-border">
            {confirmDeleteAll ? (
              <div className="flex items-center justify-center gap-2 animate-fade-in">
                <span className="text-text-muted text-xs">Delete all {sessions.length} chats?</span>
                <button
                  onClick={handleDeleteAll}
                  className="px-3 py-1.5 text-[11px] font-bold text-danger bg-danger/20 border border-danger/30 rounded hover:bg-danger/30 transition-colors cursor-pointer"
                >
                {t("sidebar.deleteAllChats")}
              </button>
              <button
                onClick={() => setConfirmDeleteAll(false)}
                className="px-3 py-1.5 text-[11px] font-bold text-text-muted bg-surface-hover border border-border rounded hover:text-text-secondary transition-colors cursor-pointer"
              >
                {t("common.cancel")}
              </button>
              </div>
            ) : (
              <button
                onClick={handleDeleteAll}
                className="w-full flex items-center justify-center gap-2 py-2 text-text-muted hover:text-danger hover:bg-danger/10 rounded-lg transition-colors cursor-pointer"
                title={t("sidebar.deleteAllChats")}
              >
                <svg
                  width="16"
                  height="16"
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
              <span className="text-xs font-medium">{t("sidebar.deleteAllChats")}</span>
            </button>
            )}
          </div>
        )}

        {/* Settings Link */}
        <button
          onClick={() => navigate("/settings")}
          className="w-full flex items-center justify-center gap-2 py-3 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
          title={t("sidebar.settings")}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="text-xs font-medium">{t("sidebar.settings")}</span>
        </button>
      </div>

      {/* Resize Handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}
