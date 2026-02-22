import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { useWebRTC } from "../hooks/useWebRTC";
import { useSettings } from "../contexts/SettingsContext";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { CallOverlay } from "../components/CallOverlay";
import { IncomingCallNotification } from "../components/IncomingCallNotification";
import { PollCountdown } from "../components/PollCountdown";
import {
  markSessionAsRead,
  generateSessionId,
  getInviteCode,
  deleteSession,
  loadSession,
  updateSessionLabel,
  addMessage,
} from "../lib/storage";
import type { ChatParams, CallSignal, CallEventType, ChatMessage } from "../lib/types";

export function Chat() {
  const { "*": splat } = useParams();
  const navigate = useNavigate();
  const { settings } = useSettings();
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
      nick: settings.defaultNickname || undefined,
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
    incomingCallSignal,
    setCallSignal,
    setChatFastPoll,
    addSystemMessage,
    setNick,
    pollCountdown,
  } = useChat(params);

  useEffect(() => {
    if (settings.defaultNickname) {
      setNick(settings.defaultNickname);
    }
  }, [settings.defaultNickname, setNick]);

  const addCallEventMessage = useCallback(
    (type: CallEventType, hasVideo: boolean, duration?: number) => {
      const textMap: Record<CallEventType, string> = {
        call_started: hasVideo ? "Video call started" : "Audio call started",
        call_received: hasVideo ? "Incoming video call" : "Incoming audio call",
        call_connected: hasVideo ? "Video call connected" : "Audio call connected",
        call_ended: hasVideo ? "Video call ended" : "Audio call ended",
        call_missed: hasVideo ? "Missed video call" : "Missed audio call",
        call_rejected: hasVideo ? "Video call declined" : "Audio call declined",
      };

      const msg: ChatMessage = {
        id: `system_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: textMap[type],
        sender: "system",
        timestamp: Date.now(),
        callEvent: {
          type,
          hasVideo,
          duration,
        },
      };

      addSystemMessage?.(msg);
    },
    [addSystemMessage],
  );

  const webrtc = useWebRTC({
    incomingCallSignal,
    publishCallSignal: setCallSignal,
    setFastPoll: setChatFastPoll,
    addCallEventMessage,
  });

  const incomingHasVideo = (() => {
    if (!incomingCallSignal) return false;
    try {
      const sig: CallSignal = JSON.parse(incomingCallSignal);
      return sig.m?.includes("v") ?? false;
    } catch {
      return false;
    }
  })();

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [chatLabel, setChatLabel] = useState<string>("");
  const [peerNick, setPeerNick] = useState<string>("");
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showTechInfo, setShowTechInfo] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (params) {
      const sessionId = generateSessionId(params.seedB64, params.peerPubKeyB64);
      const code = getInviteCode(sessionId);
      setInviteCode(code);
      const session = loadSession(sessionId);
      setChatLabel(session?.label || "");
      setPeerNick(session?.nick || "");
    }
  }, [params?.seedB64, params?.peerPubKeyB64]);

  useEffect(() => {
    const peerMessages = [...messages].reverse().filter(m => 
      m.sender === "peer" || (m.sender === "system" && m.id.startsWith("peer_"))
    );
    
    for (const msg of peerMessages) {
      if (msg.nick) {
        if (msg.nick !== peerNick) {
          setPeerNick(msg.nick);
        }
        return;
      }
      
      const joinMatch = msg.text.match(/^👋 (.+) joined$/);
      if (joinMatch && joinMatch[1]) {
        const extractedNick = joinMatch[1];
        if (extractedNick !== peerNick) {
          setPeerNick(extractedNick);
        }
        return;
      }
    }
  }, [messages, peerNick]);

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
    window.dispatchEvent(new Event("session-updated"));
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
    setMenuOpen(false);
  }, [splat]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

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

  const truncatedPeerKey = params.peerPubKeyB64.slice(0, 12) + "...";
  const displayName = chatLabel || peerNick;
  const isAnonymous = !displayName;
  const showKeySubtitle = true;

  return (
    <div className="flex-1 flex flex-col h-full bg-chat-bg">
      {/* Chat Header */}
      <div className="h-14 flex items-center justify-between px-4 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-10 h-10 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
            <span className={`text-sm ${isAnonymous ? "text-text-muted/50" : "text-text-muted"}`}>
              {(displayName || "A").charAt(0).toUpperCase()}
            </span>
            {inviteCode && (
              <span className="absolute -bottom-0.5 -right-0.5 w-[16px] h-[16px] flex items-center justify-center rounded-full text-[8px] bg-accent text-[#111b21] z-10 group/star">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
                <span className="absolute top-1/2 -translate-y-1/2 left-full ml-2 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover/star:opacity-100 transition-opacity pointer-events-none shadow-lg border border-border">
                  You created this chat
                </span>
              </span>
            )}
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
                className={`text-[15px] font-normal m-0 leading-tight truncate cursor-pointer hover:text-accent transition-colors ${isAnonymous ? "text-text-muted/60 italic" : "text-text-primary"}`}
                title="Click to set a name"
              >
                {displayName || "Anonymous"}
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
            <div 
              className="flex items-center gap-1.5 cursor-help"
              title={techInfo ? `Status: ${statusLabel}\nYou: ${techInfo.myPubKey}\nPeer: ${techInfo.peerPubKey}` : `Status: ${statusLabel}`}
            >
              <PollCountdown
                remaining={pollCountdown.remaining}
                total={pollCountdown.total}
                isPolling={pollCountdown.isPolling}
                size={14}
              />
              {showKeySubtitle && (
                <span className="text-text-muted/60 text-xs font-mono truncate">
                  {truncatedPeerKey}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Audio call button */}
          <button
            onClick={() => webrtc.startCall(false)}
            disabled={webrtc.callState !== "idle"}
            className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Audio call"
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
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </button>
          {/* Video call button */}
          <button
            onClick={() => webrtc.startCall(true)}
            disabled={webrtc.callState !== "idle"}
            className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Video call"
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
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </button>
          {/* Options dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
              title="Options"
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
                <circle cx="12" cy="12" r="1" />
                <circle cx="12" cy="5" r="1" />
                <circle cx="12" cy="19" r="1" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-surface-alt border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50 animate-fade-in">
                {inviteCode && (
                  <button
                    onClick={() => {
                      handleCopyCode(inviteCode);
                      setMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
                  >
                    {codeCopied ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    )}
                    {codeCopied ? "Copied!" : "Copy invite code"}
                  </button>
                )}
                <button
                  onClick={() => {
                    forceRefresh();
                    setMenuOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                  </svg>
                  Refresh
                </button>
                <button
                  onClick={() => {
                    setShowTechInfo(true);
                    setMenuOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  Tech Info
                </button>
                <div className="border-t border-border my-1" />
                {confirmDelete ? (
                  <div className="px-3 py-2 flex items-center gap-2">
                    <span className="text-danger text-xs">Delete?</span>
                    <button
                      onClick={() => {
                        handleDelete();
                        setMenuOpen(false);
                      }}
                      className="px-2 py-0.5 bg-danger/20 text-danger border border-danger/30 rounded text-xs font-bold hover:bg-danger/30 transition-colors cursor-pointer"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="px-2 py-0.5 bg-surface-hover text-text-muted border border-border rounded text-xs font-bold hover:text-text-secondary transition-colors cursor-pointer"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleDelete}
                    className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-surface-hover flex items-center gap-2 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                    Delete chat
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

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

      {/* Incoming call notification */}
      {webrtc.callState === "incoming" && (
        <IncomingCallNotification
          peerName={displayName || "Anonymous"}
          hasVideo={incomingHasVideo}
          onAcceptAudio={() => webrtc.acceptCall(false)}
          onAcceptVideo={() => webrtc.acceptCall(true)}
          onReject={webrtc.rejectCall}
        />
      )}

      {/* Active call overlay */}
      {(webrtc.callState === "offering" ||
        webrtc.callState === "answering" ||
        webrtc.callState === "connecting" ||
        webrtc.callState === "connected") && (
        <CallOverlay
          callState={webrtc.callState}
          localStream={webrtc.localStream}
          remoteStream={webrtc.remoteStream}
          isMuted={webrtc.isMuted}
          isVideoOff={webrtc.isVideoOff}
          hasVideo={webrtc.hasVideo}
          callStartedAt={webrtc.callStartedAt}
          peerName={displayName || "Anonymous"}
          onHangUp={() => webrtc.hangUp()}
          onToggleMute={webrtc.toggleMute}
          onToggleVideo={webrtc.toggleVideo}
        />
      )}

      {/* Tech Info Modal */}
      {showTechInfo && techInfo && (
        <div 
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowTechInfo(false)}
        >
          <div 
            className="bg-surface-alt rounded-xl max-w-md w-full max-h-[80vh] overflow-y-auto shadow-2xl animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="text-lg font-semibold text-text-primary">Tech Info</h2>
              <button
                onClick={() => setShowTechInfo(false)}
                className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded-full transition-colors"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-4 space-y-4 text-sm">
              <TechInfoSection title="Identity">
                <TechInfoRow label="Session ID" value={techInfo.sessionId} mono copyable />
                <TechInfoRow label="My Key" value={techInfo.myPubKey} mono copyable />
                <TechInfoRow label="Peer Key" value={techInfo.peerPubKey} mono copyable />
                <TechInfoRow label="Enc Key" value={techInfo.encKeyPreview} mono />
              </TechInfoSection>
              <TechInfoSection title="Protocol">
                <TechInfoRow label="Network" value={techInfo.protocol} />
                <TechInfoRow label="Encryption" value={techInfo.encryption} />
                <TechInfoRow label="TTL" value={`${techInfo.messageTtl}s`} />
                <TechInfoRow label="Created" value={new Date(techInfo.createdAt).toLocaleString()} />
              </TechInfoSection>
              <TechInfoSection title="Sync">
                <TechInfoRow label="Status" value={status} />
                <TechInfoRow label="Poll Interval" value={`${techInfo.currentPollInterval / 1000}s`} />
                <TechInfoRow label="Polls" value={techInfo.pollCount.toString()} />
                <TechInfoRow label="Last Sync" value={lastSync ? new Date(lastSync).toLocaleTimeString() : "—"} />
                <TechInfoRow label="Messages" value={messages.length.toString()} />
              </TechInfoSection>
              <TechInfoSection title="ACK Status">
                <TechInfoRow 
                  label="My ACK" 
                  value={techInfo.myAck > 0 ? new Date(techInfo.myAck).toLocaleTimeString() : "none"} 
                />
                <TechInfoRow 
                  label="Peer ACK" 
                  value={techInfo.peerAck > 0 ? new Date(techInfo.peerAck).toLocaleTimeString() : "none"} 
                />
                <TechInfoRow label="Pending Buffer" value={`${techInfo.sentBufferSize} messages`} />
              </TechInfoSection>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TechInfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold text-accent uppercase tracking-wider">{title}</h3>
      <div className="bg-surface rounded-lg p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function TechInfoRow({ label, value, mono, copyable }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-text-muted shrink-0">{label}</span>
      {copyable ? (
        <button
          onClick={handleCopy}
          className={`text-right break-all bg-transparent border-none p-0 cursor-pointer hover:text-accent transition-colors ${mono ? "font-mono" : ""} ${copied ? "text-accent" : "text-text-secondary"}`}
          title="Click to copy"
        >
          {copied ? "Copied!" : value}
        </button>
      ) : (
        <span className={`text-text-secondary text-right break-all ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      )}
    </div>
  );
}
