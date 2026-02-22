import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { TechPanel } from "../components/TechPanel";
import {
  markSessionAsRead,
  generateSessionId,
  getInviteCode,
  deleteSession,
  loadSession,
  updateSessionLabel,
} from "../lib/storage";
import type { ChatParams } from "../lib/types";

export function Chat() {
  const { "*": splat } = useParams();
  const navigate = useNavigate();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const params: ChatParams | null = (() => {
    if (!splat) return null;
    const parts = splat.split("/");
    if (parts.length !== 3) return null;
    return {
      seedB64: parts[0],
      peerPubKeyB64: parts[1],
      encKeyB64: parts[2],
    };
  })();

  const {
    messages,
    status,
    lastSync,
    isSending,
    sendMessage,
    techInfo,
    peerAck,
    forceRefresh,
  } = useChat(params);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [chatLabel, setChatLabel] = useState<string>("");
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (params) {
      const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
      const code = getInviteCode(sessionId);
      setInviteCode(code);
      const session = loadSession(sessionId);
      setChatLabel(session?.label || "");
    }
  }, [params?.seedB64, params?.peerPubKeyB64]);

  const startEditLabel = () => {
    setLabelDraft(chatLabel);
    setIsEditingLabel(true);
    setTimeout(() => labelInputRef.current?.focus(), 0);
  };

  const saveLabel = () => {
    if (!params) return;
    const trimmed = labelDraft.trim();
    const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
    updateSessionLabel(sessionId, trimmed);
    setChatLabel(trimmed);
    setIsEditingLabel(false);
  };

  const handleCopyCode = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  useEffect(() => {
    setConfirmDelete(false);
    setCodeCopied(false);
  }, [splat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (params) {
      const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
      markSessionAsRead(sessionId);
    }
  }, [params, messages.length]);

  if (!params) {
    return <Navigate to="/" replace />;
  }

  const handleDelete = () => {
    if (confirmDelete) {
      const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
      deleteSession(sessionId);
      navigate("/");
    } else {
      setConfirmDelete(true);
    }
  };

  const statusConfig = {
    connecting: { color: "bg-yellow-500", label: "connecting" },
    online: { color: "bg-accent", label: "online" },
    offline: { color: "bg-gray-500", label: "offline" },
    error: { color: "bg-danger", label: "error" },
  };
  const { color: statusColor, label: statusLabel } = statusConfig[status];

  const syncText = lastSync
    ? new Date(lastSync).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const truncatedKey = params.peerPubKeyB64.slice(0, 12) + "...";
  const displayName = chatLabel || truncatedKey;

  return (
    <div className="flex-1 flex flex-col h-full bg-chat-bg">
      {/* Chat Header */}
      <div className="h-14 flex items-center justify-between px-4 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-10 h-10 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
            <span className="text-text-muted text-sm">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-[16px] h-[16px] flex items-center justify-center rounded-full text-[8px] ${
                inviteCode
                  ? "bg-accent text-[#111b21]"
                  : "bg-blue-500 text-white"
              }`}
              title={inviteCode ? "You created this chat" : "You joined this chat"}
            >
              {inviteCode ? (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
              )}
            </span>
          </div>
          <div className="min-w-0">
            {isEditingLabel ? (
              <input
                ref={labelInputRef}
                type="text"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveLabel();
                  if (e.key === "Escape") setIsEditingLabel(false);
                }}
                onBlur={saveLabel}
                placeholder="Set a name..."
                className="bg-input-bg border-none rounded px-2 py-0.5 text-[15px] text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent w-full max-w-[200px]"
                maxLength={30}
              />
            ) : (
              <p
                onClick={startEditLabel}
                className="text-text-primary text-[15px] font-normal m-0 leading-tight truncate cursor-pointer hover:text-accent transition-colors"
                title="Click to set a name"
              >
                {displayName}
                {!chatLabel && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="inline ml-1.5 text-text-muted opacity-0 group-hover:opacity-100"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                )}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${statusColor} ${status === "connecting" ? "animate-pulse-dot" : ""}`}
              />
              <span className="text-text-muted text-xs">
                {statusLabel}
                {syncText && ` · ${syncText}`}
                {" · "}
                <span className={inviteCode ? "text-accent" : "text-blue-400"}>
                  {inviteCode ? "created" : "joined"}
                </span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {inviteCode && (
            <button
              onClick={() => handleCopyCode(inviteCode)}
              className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
              title={codeCopied ? "Copied!" : "Copy invite code"}
            >
              {codeCopied ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-accent"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
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
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={forceRefresh}
            className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
            title="Force refresh"
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
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2 animate-fade-in">
              <span className="text-danger text-xs">Delete?</span>
              <button
                onClick={handleDelete}
                className="px-2.5 py-1 bg-danger/20 text-danger border border-danger/30 rounded text-xs font-bold hover:bg-danger/30 transition-colors cursor-pointer"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2.5 py-1 bg-surface-hover text-text-muted border border-border rounded text-xs font-bold hover:text-text-secondary transition-colors cursor-pointer"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-2 text-text-secondary hover:text-danger rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
              title="Delete chat"
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
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Tech Panel */}
      <TechPanel
        techInfo={techInfo}
        status={status}
        lastSync={lastSync}
        messageCount={messages.length}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto chat-wallpaper">
        <div className="max-w-3xl mx-auto py-3">
          {inviteCode && messages.length === 0 && (
            <div className="flex items-center justify-center min-h-[120px]">
              <div className="bg-surface-alt/90 rounded-xl px-5 py-4 text-center max-w-sm space-y-3">
                <p className="text-text-secondary text-xs">
                  Share this invite code with your contact to start chatting:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-input-bg rounded-lg px-3 py-2 text-[10px] text-text-muted font-mono truncate text-left select-all">
                    {inviteCode}
                  </code>
                  <button
                    onClick={() => handleCopyCode(inviteCode)}
                    className="px-3 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer shrink-0"
                  >
                    {codeCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!inviteCode && messages.length === 0 && (
            <div className="flex items-center justify-center min-h-[200px]">
              <div className="bg-surface-alt/90 rounded-lg px-4 py-2 text-center">
                <p className="text-text-muted text-xs">
                  Send a message or wait for your contact
                </p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} peerAck={peerAck} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <MessageInput key={splat} onSend={sendMessage} disabled={isSending} />
    </div>
  );
}
