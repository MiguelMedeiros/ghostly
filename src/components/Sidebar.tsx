import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { usePkarr } from "../hooks/usePkarr";
import { useBackgroundPoller } from "../hooks/useBackgroundPoller";
import {
  listSessions,
  deleteSession,
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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const prevTotalMsgsRef = useRef<Record<string, number>>({});
  const lastNotifRef = useRef<number>(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const initialSyncCompleteRef = useRef(false);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isResizingRef = useRef(false);

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

  const { initialSyncComplete } =
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
      initialSyncCompleteRef.current
    ) {
      lastNotifRef.current = now;
      playNotificationSound();
    }

    setSessions(updated);
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 3000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  useEffect(() => {
    if (activeSessionId) markSessionAsRead(activeSessionId);
  }, [activeSessionId, sessions]);

  const handleCreate = async () => {
    const drop = await createDrop();
    const sessionId = generateSessionId(drop.seedA, drop.pubKeyB);
    saveInviteCode(sessionId, drop.inviteCode);
    setShowNewChat(false);
    navigate(`/chat/${drop.seedA}/${drop.pubKeyB}/${drop.encKey}`);
    setTimeout(refreshSessions, 500);
  };

  const handleJoin = () => {
    setJoinError("");
    const input = inviteInput.trim();
    if (!input) return;

    let chatPath: string | null = null;

    try {
      const url = new URL(input);
      const hash = url.hash;
      if (hash && hash.includes("/chat/")) {
        chatPath = hash.replace(/^#/, "");
      }
    } catch {
      // not a valid URL — try other formats
    }

    if (!chatPath && input.includes("/chat/")) {
      const idx = input.indexOf("/chat/");
      chatPath = input.slice(idx);
    }

    if (!chatPath) {
      const cleaned = input.replace(/^\/+/, "").replace(/\/+$/, "");
      const segments = cleaned.split("/");
      if (segments.length === 3 && segments.every((s) => s.length > 0)) {
        chatPath = `/chat/${cleaned}`;
      }
    }

    if (chatPath) {
      setInviteInput("");
      setShowNewChat(false);
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
        <span className="text-accent font-bold text-base tracking-tight">
          DEAD DROP
        </span>
        <button
          onClick={() => {
            setShowNewChat(!showNewChat);
            setJoinError("");
            setInviteInput("");
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
          title="New chat"
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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <line x1="12" y1="8" x2="12" y2="14" />
            <line x1="9" y1="11" x2="15" y2="11" />
          </svg>
          <span className="text-xs font-medium">New</span>
        </button>
      </div>

      {/* New Chat Panel */}
      {showNewChat && (
        <div className="border-b border-border bg-surface-alt p-4 space-y-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-xs font-bold uppercase tracking-wider">
              New Chat
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

          <div className="space-y-2">
            <p className="text-text-muted text-xs">
              Paste an invite code to join an existing chat:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => {
                  setInviteInput(e.target.value);
                  setJoinError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                placeholder="Paste invite code..."
                className="flex-1 bg-input-bg border-none rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none font-mono"
              />
              <button
                onClick={handleJoin}
                disabled={!inviteInput.trim()}
                className="px-4 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                Join
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
            Create New Chat
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
            placeholder="Search or start new chat"
            className="flex-1 bg-transparent border-none text-sm text-text-primary placeholder-text-muted focus:outline-none py-1"
          />
        </div>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="text-text-muted text-4xl mb-4">&#9670;</div>
            <p className="text-text-secondary text-sm mb-1">No chats yet</p>
            <p className="text-text-muted text-xs">
              Create a drop or join with an invite link
            </p>
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
          const peerLabel =
            session.label || session.nick || session.peerPubKeyB64.slice(0, 12) + "...";
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
              <div className="relative w-12 h-12 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
                <span className="text-text-muted text-lg">
                  {peerLabel.charAt(0).toUpperCase()}
                </span>
                {unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-accent text-[#111b21] text-[10px] font-bold rounded-full px-1">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] flex items-center justify-center rounded-full text-[9px] ${
                    isCreator
                      ? "bg-accent text-[#111b21]"
                      : "bg-blue-500 text-white"
                  }`}
                  title={isCreator ? "You created this chat" : "You joined this chat"}
                >
                  {isCreator ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                  )}
                </span>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 border-b border-border py-1">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className={`text-[15px] truncate ${unread > 0 ? "text-text-primary font-semibold" : "text-text-primary"}`}>
                    {peerLabel}
                  </span>
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
                        Delete
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setConfirmDeleteId(null);
                        }}
                        className="px-2 py-0.5 text-[10px] font-bold text-text-muted bg-surface-hover border border-border rounded hover:text-text-secondary transition-colors cursor-pointer"
                      >
                        Cancel
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
                        title="Delete chat"
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

      {/* Resize Handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}
