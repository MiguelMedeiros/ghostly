import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { usePeerNick, useShareProfile } from "../hooks/useAvatars";
import { PeerAvatar } from "../components/Avatar";
import { useOutsideDismiss, useBackdropDismiss } from "../hooks/useDismiss";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { createPortal } from "react-dom";
import { ChatPaymentsDialog } from "../components/ChatPaymentsDialog";
import { ChatHoldDialog } from "../components/ChatHoldDialog";
import { ChatIdentitiesDialog } from "../components/identities/ChatIdentitiesDialog";
import { IdentityBadges } from "../components/identities/IdentityBadges";
import { ChatServicesDialog } from "../components/ChatServicesDialog";
import { PinIcon } from "../components/PinIcon";
import { useI18n } from "../contexts/I18nContext";
import { InviteCard } from "../components/InviteCard";
import { PairingBanner } from "../components/PairingBanner";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { useWebRTC } from "../hooks/useWebRTC";
import { useSettings } from "../contexts/SettingsContext";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { CallOverlay } from "../components/CallOverlay";
import { IncomingCallNotification } from "../components/IncomingCallNotification";
import { contactStatus } from "../lib/contactStatus";
import { PeerServices } from "../components/PeerServices";
import { formatFileSize } from "../lib/format";
import { playSound, startRinging } from "../lib/sounds";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import {
  isSessionPinned,
  setSessionPinned,
  markSessionAsRead,
  getInviteCode,
  deleteSession,
  loadSession,
  peerDisplayName,
  updateSessionLabel,
} from "../lib/storage";
import { chatPath } from "../lib/url";
import { parseCallSignal, signalHasVideo } from "@ghostly/core";
import type { ChatParams, CallEventType, ChatMessage } from "../lib/types";

interface ChatProps {
  /** The stored session this chat is. `App` reads it off the address. */
  sessionId: string;
  /** False while the chat is off screen: it stays loaded, only for the call it holds. */
  visible: boolean;
  /** Tells `App` whether this chat is on a call, so it stays loaded wherever you go. */
  onCallChange: (sessionId: string, onCall: boolean) => void;
  /** Where the call window hangs, outside this chat. `App` owns it. */
  callLayer: HTMLElement | null;
}

export function Chat({ sessionId, visible, onCallChange, callLayer }: ChatProps) {
  const navigate = useNavigate();
  const { t, language } = useI18n();
  const { settings } = useSettings();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const session = useMemo(() => (sessionId ? loadSession(sessionId) : null), [sessionId]);
  const sharedNick = useShareProfile() ? settings.defaultNickname : "";
  const params: ChatParams | null = useMemo(
    () =>
      session
        ? {
            profile: session.profile,
            deliveryMode: session.deliveryMode,
            sessionId: session.id,
            seedB64: session.mySeedB64,
            peerPubKeyB64: session.peerPubKeyB64,
            encKeyB64: session.encKeyB64,
            nick: sharedNick || undefined,
          }
        : null,
    [session, sharedNick],
  );

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
    deleteMessage,
    pollCountdown,
    setNick,
  } = useChat(params);

  // Only what contacts may see: the join notice names nobody while this profile does not share its name.
  useEffect(() => {
    setNick(sharedNick);
  }, [sharedNick, setNick]);

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

  const callState = webrtc.callState;
  const previousCallState = useRef(callState);
  useEffect(() => {
    const before = previousCallState.current;
    previousCallState.current = callState;
    if (callState === "incoming") return startRinging("ring");
    if (callState === "offering") return startRinging("ringback");
    if (callState === "idle" && before !== "idle") playSound("hangup");
  }, [callState]);

  // A chat on a call is kept loaded by `App` wherever the person goes next,
  // so the call itself — and the signaling that ends it — survives the trip.
  useEffect(() => {
    onCallChange(sessionId, callState !== "idle");
  }, [onCallChange, sessionId, callState]);
  useEffect(() => () => onCallChange(sessionId, false), [onCallChange, sessionId]);

  const incomingHasVideo = (() => {
    if (!incomingCallSignal) return false;
    return signalHasVideo(parseCallSignal(incomingCallSignal));
  })();

  const platform = useServicesPlatform();
  const paired = session?.profile === "paired-chat/1";
  const deliveryPeer = platform?.getPeer(session?.peerPubKeyB64 ?? "");
  const dhtOnly = deliveryPeer?.deliveryMode === "dht" || deliveryPeer?.textDelivery === "dht";
  const pairedReady = deliveryPeer?.pairing?.status === "ready";
  const textReady = deliveryPeer?.canSendText ?? pairedReady;
  const peerKey = params?.peerPubKeyB64;
  const sendFile = useCallback(
    async (source: File): Promise<string | null> => {
      if (!platform || !peerKey) return null;
      if (source.size > platform.maxFileBytes) {
        return `That file is too large (max ${formatFileSize(platform.maxFileBytes)}).`;
      }
      try {
        const { timestamp, file } = await platform.sendFile(peerKey, source);
        addSystemMessage({ id: `me_${timestamp}`, text: `📎 ${file.name}`, sender: "me", timestamp, file });
        window.dispatchEvent(new Event("session-updated"));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [platform, peerKey, addSystemMessage],
  );

  /**
   * Forgets a message here: the chat history first, so the bubble goes at
   * once, then the peer's own copy of it and the bytes of any file it carried.
   * Nothing is sent — the contact keeps what it has.
   */
  const forgetMessage = useCallback(
    (messageId: string) => {
      deleteMessage(messageId);
      if (peerKey) void platform?.deleteMessage(peerKey, messageId).catch(() => {});
    },
    [deleteMessage, platform, peerKey],
  );

  const wallet = platform?.wallet;
  const walletState = wallet?.getState() ?? null;
  const pay = useCallback(
    async (kind: "send" | "request", amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin"): Promise<string | null> => {
      if (!wallet || !peerKey) return null;
      try {
        const { timestamp, paymentId } = await (kind === "request" ? wallet.request(peerKey, amount, memo || undefined, method) : wallet.send(peerKey, amount, memo || undefined));
        const text = method === "usdt" ? "Token payment request" : kind === "send" ? `⚡ ${amount.toLocaleString()} sats` : `⚡ Requested ${amount.toLocaleString()} sats`;
        addSystemMessage({ id: `me_${timestamp}`, text, sender: "me", timestamp, paymentId });
        window.dispatchEvent(new Event("session-updated"));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [wallet, peerKey, addSystemMessage],
  );
  const paySend = useCallback((amount: number, memo: string) => pay("send", amount, memo), [pay]);
  const payRequest = useCallback((amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin") => pay("request", amount, memo, method), [pay]);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [chatLabel, setChatLabel] = useState<string>("");
  const [peerNick, setPeerNick] = useState<string>("");
  const profileNick = usePeerNick(params?.peerPubKeyB64);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  /** Ways of paying are chosen per chat; the ⚡ works while this device allows at least one. */
  const chatPeer = platform?.getPeer(params?.peerPubKeyB64 ?? "");
  const paymentsOn = !chatPeer?.paymentMethods || Object.values(chatPeer.paymentMethods).some(Boolean);
  const [showPayments, setShowPayments] = useState(false);
  const [showHold, setShowHold] = useState(false);
  const [showIdentities, setShowIdentities] = useState(false);
  const [showServices, setShowServices] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionRef = useRef<HTMLDivElement>(null);
  const connectionButtonRef = useRef<HTMLButtonElement>(null);
  const [showTechInfo, setShowTechInfo] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionId) {
      setInviteCode(getInviteCode(sessionId));
      const stored = loadSession(sessionId);
      setChatLabel(stored?.label || "");
      setPeerNick(stored?.nick || "");
    }
  }, [sessionId]);

  useEffect(() => {
    const peerMessages = [...messages].reverse().filter(m => 
      m.sender === "peer" || (m.sender === "system" && m.id.startsWith("peer_"))
    );
    
    for (const msg of peerMessages) {
      if (msg.nick) {
        const nick = peerDisplayName(msg.nick);
        if (nick && nick !== peerNick) {
          setPeerNick(nick);
        }
        return;
      }

      const joinMatch = msg.text.match(/^👋 (.+) joined$/);
      if (joinMatch && joinMatch[1]) {
        const extractedNick = peerDisplayName(joinMatch[1]);
        if (extractedNick && extractedNick !== peerNick) {
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
    if (!sessionId) return;
    const trimmed = labelDraft.trim();
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
    setConnectionOpen(false);
  }, [sessionId]);

  useOutsideDismiss(menuRef, menuOpen, () => setMenuOpen(false));
  useOutsideDismiss(connectionRef, connectionOpen, () => {
    if (connectionRef.current?.contains(document.activeElement)) connectionButtonRef.current?.focus();
    setConnectionOpen(false);
  });
  const techBackdrop = useBackdropDismiss(() => setShowTechInfo(false));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Only what is on screen has been read; a chat kept alive by a call has not.
  useEffect(() => {
    if (visible) markSessionAsRead(sessionId);
  }, [visible, sessionId, messages.length]);

  if (!params) {
    // A chat still on a call has nowhere better to be; only the one on screen leaves.
    return visible ? <Navigate to="/" replace /> : null;
  }

  const handleDelete = () => {
    if (confirmDelete) {
      deleteSession(params.sessionId);
      // The chat list keeps its own copy: without this it shows the deleted chat until its next refresh.
      window.dispatchEvent(new Event("session-updated"));
      navigate("/");
    } else {
      setConfirmDelete(true);
    }
  };

  const statusLabel = contactStatus(deliveryPeer, paired, status);

  const truncatedPeerKey = publicKeyLabel(params.peerPubKeyB64);
  // What the contact last said on the session wins over a name read out of an older message.
  const contactNick = profileNick !== undefined ? profileNick : peerNick;
  const displayName = chatLabel || contactNick;
  const isAnonymous = !displayName;
  const shownName = displayName || t("common.unnamedContact", { key: contactTag(params.peerPubKeyB64) });
  const showKeySubtitle = true;

  return (
    <div className="flex-1 flex flex-col h-full bg-chat-bg">
      {/* Chat Header */}
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:ps-1 max-md:pe-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1.5 min-w-0">
          <button
            onClick={() => navigate("/")}
            className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0"
            title="Back"
            data-testid="chat-back"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="relative w-10 h-10 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
            <PeerAvatar peerPubKey={params?.peerPubKeyB64} label={shownName} named={!isAnonymous} testId="chat-avatar" />
            {inviteCode && !pairedReady && (
              <span className="absolute -bottom-0.5 -end-0.5 w-[16px] h-[16px] flex items-center justify-center rounded-full text-[8px] bg-accent text-[#111b21] z-10 group/star">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
                <span className="absolute top-1/2 -translate-y-1/2 start-full ms-2 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover/star:opacity-100 transition-opacity pointer-events-none shadow-lg border border-border">
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
              <div className="flex items-center gap-1.5 min-w-0">
              <p
                onClick={startEditLabel}
                className={`text-[15px] font-normal m-0 leading-tight truncate cursor-pointer hover:text-accent transition-colors ${isAnonymous ? "text-text-muted/60 italic" : "text-text-primary"}`}
                title="Click to set a name"
              >
                {shownName}
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
                    className="inline ms-1.5 text-text-muted opacity-0 group-hover:opacity-100"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                )}
              </p>
              {paired && <IdentityBadges peerKey={params.peerPubKeyB64} onOpen={() => setShowIdentities(true)} />}
              </div>
            )}
            <div ref={connectionRef} className="relative">
              <button
                ref={connectionButtonRef}
                type="button"
                aria-label="Connection details"
                aria-expanded={connectionOpen}
                aria-controls={`connection-details-${sessionId}`}
                onClick={() => setConnectionOpen(open => !open)}
                className="flex items-center gap-1.5 rounded cursor-pointer hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <span role="img" aria-label={statusLabel} data-testid="contact-status"
                  className={`h-2 w-2 shrink-0 rounded-full ${statusLabel === "Connected" ? `bg-green-500 ${pollCountdown.isPolling ? "contact-fetch-pulse" : ""}` : /issue|unavailable|mismatch/.test(statusLabel) ? "bg-danger" : "bg-text-muted"}`} />
                {showKeySubtitle && (
                  <span className="text-text-muted/60 text-xs max-md:text-[10px] font-mono whitespace-nowrap">
                    {truncatedPeerKey}
                  </span>
                )}
              </button>
              {connectionOpen && (
                <div id={`connection-details-${sessionId}`} role="region" aria-label="Connection details"
                  className="absolute start-0 top-full z-50 mt-2 w-80 max-w-[75vw] rounded-lg border border-border bg-surface-alt p-4 shadow-xl space-y-3">
                  <TechInfoRow label="Connection" value={statusLabel} />
                  {techInfo?.myPubKey && <TechInfoRow label="You" value={techInfo.myPubKey} mono copyable />}
                  <TechInfoRow label="Peer" value={params.peerPubKeyB64} mono copyable />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Audio call button */}
          {paired && <PairingBanner peerKey={params.peerPubKeyB64} />}
          <button
            onClick={() => webrtc.startCall(false)}
            disabled={paired || webrtc.callState !== "idle"}
            className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title={paired ? "Audio calls are not supported in this chat" : "Audio call"}
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
          {/* Screen share: a video call whose picture is the screen. Phones cannot capture theirs. */}
          {typeof navigator.mediaDevices?.getDisplayMedia === "function" && (
            <button
              onClick={() => webrtc.startCall(true, "screen")}
              disabled={paired || webrtc.callState !== "idle"}
              className="max-md:hidden p-2 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title={paired ? "Screen sharing is not supported in this chat" : "Share your screen"}
              data-testid="call-screen"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M8 21h8M12 17v4M12 13V8m0 0l-2.5 2.5M12 8l2.5 2.5" />
              </svg>
            </button>
          )}
          {/* Video call button */}
          <button
            onClick={() => webrtc.startCall(true)}
            disabled={paired || webrtc.callState !== "idle"}
            className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title={paired ? "Video calls are not supported in this chat" : "Video call"}
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
              className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
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
              <div data-testid="chat-options-menu" className="absolute end-0 top-full mt-1 bg-surface-alt border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50 animate-fade-in">
                <button onClick={() => { setSessionPinned(sessionId, !isSessionPinned(sessionId)); setMenuOpen(false); }}
                  className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors">
                  <PinIcon active={isSessionPinned(sessionId)} />{isSessionPinned(sessionId) ? "Unpin chat" : "Pin chat"}
                </button>
                {inviteCode && !pairedReady && (
                  <button
                    onClick={() => {
                      handleCopyCode(inviteCode);
                      setMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
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
                {platform?.wallet && platform.getPeer(params.peerPubKeyB64) && (
                  <button data-testid="chat-payments-open" onClick={() => { setShowPayments(true); setMenuOpen(false); }}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                    Payments…
                  </button>
                )}
                {paired && platform?.getPeer(params.peerPubKeyB64) && (
                  <button data-testid="chat-hold-open" onClick={() => { setShowHold(true); setMenuOpen(false); }}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>
                    Hold messages…
                  </button>
                )}
                {paired && (
                  <button data-testid="chat-identities-open" onClick={() => { setShowIdentities(true); setMenuOpen(false); }}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>
                    Identities…
                  </button>
                )}
                {platform && platform.getPeer(params.peerPubKeyB64) && (
                  <button data-testid="chat-services-open" onClick={() => { setShowServices(true); setMenuOpen(false); }}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
                    Services…
                  </button>
                )}
                <button
                  onClick={() => {
                    forceRefresh();
                    setMenuOpen(false);
                  }}
                  className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
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
                  className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary flex items-center gap-2 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  Tech Info
                </button>
                <div className="border-t border-border my-1" />
                  <button
                    onClick={() => {setConfirmDelete(true); setMenuOpen(false);}}
                    className="w-full px-3 py-2 max-md:min-h-11 text-start text-sm text-danger hover:bg-surface-hover flex items-center gap-2 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                    {t("sidebar.deleteChat")}
                  </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <PeerServices peerPubKey={params.peerPubKeyB64} showLink={!paired} onManage={() => setShowServices(true)} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto chat-wallpaper">
        <div className="max-w-3xl mx-auto py-3">
          {session?.createdAt && Number.isFinite(session.createdAt) && session.createdAt > 0 && (
            <p data-testid="chat-created" className="mb-3 px-4 text-center text-[11px] text-text-muted">
              <time dateTime={new Date(session.createdAt).toISOString()}>
                {t("common.chatCreated", {date: new Intl.DateTimeFormat(language, {dateStyle:"medium", timeStyle:"short"}).format(session.createdAt)})}
              </time>
            </p>
          )}
          {inviteCode && !pairedReady && messages.length === 0 && (
            <InviteCard code={inviteCode} sessionId={sessionId} linkId={deliveryPeer?.id} mode={deliveryPeer?.deliveryMode ?? session?.deliveryMode ?? "stream"} onChange={setInviteCode} />
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
            <MessageBubble
              key={msg.id}
              message={msg}
              peerAck={peerAck}
              peerPubKey={params.peerPubKeyB64}
              peerNick={contactNick}
              onDelete={() => forgetMessage(msg.id)}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {chatPeer?.hold && (chatPeer.hold.outstanding > 0 || chatPeer.hold.error) && (
        <div data-testid="hold-indicator" className="px-4 py-1 text-[11px] text-text-secondary bg-surface-alt/60 border-t border-border truncate" role="status">
          {chatPeer.hold.outstanding > 0 && `${chatPeer.hold.outstanding} ${chatPeer.hold.outstanding === 1 ? "item" : "items"} held for ${shownName} · ${(chatPeer.hold.bytes / 1024 / 1024).toFixed(1)} MB of ${Math.round(chatPeer.hold.maxBytes / 1024 / 1024)} MB`}
          {chatPeer.hold.outstanding > 0 && chatPeer.hold.error && " · "}
          {chatPeer.hold.error && <span className="text-danger">{chatPeer.hold.error}</span>}
        </div>
      )}

      {/* Input */}
      <MessageInput draftId={sessionId}
        key={sessionId}
        onSend={sendMessage}
        disabled={isSending || (paired && !textReady)}
        disabledPlaceholder="Message…"
        // The DHT carries a few hundred characters; the direct link has room for long invoices and ecash tokens.
        maxBytes={dhtOnly ? deliveryPeer?.dhtDelivery?.maxTextBytes ?? 256 : undefined}
        maxLength={paired ? 16_384 : platform?.getPeer(params.peerPubKeyB64)?.dataLink === "open" ? 4000 : undefined}
        onSendFile={platform ? sendFile : undefined}
        fileUnavailable={dhtOnly ? "DHT carries text only. Choose a live connection for files." : paired && !platform?.getPeer(params.peerPubKeyB64)?.capabilities?.files ? (pairedReady ? "Update both peers to send files" : "Connect and confirm your peer to send files, or hold messages for them under ⋮ → Hold messages") : undefined}
        paymentsUnavailable={!paymentsOn ? "Payments are off in this chat. Choose them under ⋮ → Payments." : dhtOnly ? "DHT carries text only. Choose a live connection for sats." : paired && !platform?.getPeer(params.peerPubKeyB64)?.capabilities?.payments ? (pairedReady ? "Your contact has payments off in this chat, or needs an updated Ghostly" : deliveryPeer?.textDelivery === "hold" ? "Your contact allowed neither Cashu nor Lightning at your last session; a request cannot be held" : "Connect and confirm your peer to send sats") : undefined}
        payments={
          walletState && wallet && peerKey
            ? { balance: walletState.balance, contact: displayName || undefined, onSend: paySend, onRequest: payRequest,reviewContext:platform?.getPeer(peerKey)?.id ? {wallet,peer:peerKey,linkId:platform.getPeer(peerKey)!.id!}:undefined }
            : undefined
        }
        identities={paired ? { peerKey: params.peerPubKeyB64, contact: shownName } : undefined}
      />

      {/* Incoming call notification */}
      {/* Incoming call notification: over whatever is on screen, since this chat may not be. */}
      {webrtc.callState === "incoming" && createPortal(
        <IncomingCallNotification
          peerName={shownName}
          hasVideo={incomingHasVideo}
          onAcceptAudio={() => { webrtc.acceptCall(false); if (!visible) navigate(chatPath(sessionId)); }}
          onAcceptVideo={() => { webrtc.acceptCall(true); if (!visible) navigate(chatPath(sessionId)); }}
          onReject={webrtc.rejectCall}
        />,
        callLayer ?? document.body,
      )}

      {/* Active call overlay */}
      {(webrtc.callState === "offering" ||
        webrtc.callState === "answering" ||
        webrtc.callState === "connecting" ||
        webrtc.callState === "connected") && (
        <CallOverlay
          layer={callLayer}
          pinned={!visible}
          onReturnToChat={() => navigate(chatPath(sessionId))}
          callState={webrtc.callState}
          localStream={webrtc.localStream}
          remoteStream={webrtc.remoteStream}
          isMuted={webrtc.isMuted}
          isVideoOff={webrtc.isVideoOff}
          isScreenSharing={webrtc.isScreenSharing}
          canSendVideo={webrtc.canSendVideo}
          canShareScreen={webrtc.canShareScreen}
          remoteHasVideo={webrtc.remoteHasVideo}
          callStartedAt={webrtc.callStartedAt}
          peerName={shownName}
          onHangUp={() => webrtc.hangUp()}
          onToggleMute={webrtc.toggleMute}
          onToggleVideo={webrtc.toggleVideo}
          onToggleScreenShare={webrtc.toggleScreenShare}
        />
      )}

      {showServices && params && (
        <ChatServicesDialog peerPubKey={params.peerPubKeyB64} name={shownName} onClose={() => setShowServices(false)} />
      )}
      {showIdentities && params && (
        <ChatIdentitiesDialog peerKey={params.peerPubKeyB64} name={shownName} onClose={() => setShowIdentities(false)} />
      )}
      {showHold && chatPeer && params && platform && (
        <ChatHoldDialog peer={chatPeer} name={shownName} onClose={() => setShowHold(false)}
          onSave={(enabled) => platform.setChatHold(params.peerPubKeyB64, enabled)} />
      )}
      {showPayments && chatPeer && params && platform && (
        <ChatPaymentsDialog peer={chatPeer} name={shownName} onClose={() => setShowPayments(false)}
          onSave={(methods) => platform.setChatPaymentMethods(params.peerPubKeyB64, methods)} />
      )}
      {confirmDelete && <DeleteChatDialog name={`${shownName} · ${truncatedPeerKey}`} onClose={()=>setConfirmDelete(false)} onConfirm={handleDelete} />}
      {/* Tech Info Modal */}
      {showTechInfo && techInfo && (
        <div 
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
          {...techBackdrop}
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
          className={`text-end break-all bg-transparent border-none p-0 cursor-pointer hover:text-accent transition-colors ${mono ? "font-mono" : ""} ${copied ? "text-accent" : "text-text-secondary"}`}
          title="Click to copy"
        >
          {copied ? "Copied!" : value}
        </button>
      ) : (
        <span className={`text-text-secondary text-end break-all ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      )}
    </div>
  );
}
