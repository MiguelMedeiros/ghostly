import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { usePeerAvatar, usePeerNick, useShareProfile } from "../hooks/useAvatars";
import { PeerAvatar } from "../components/Avatar";
import { AvatarOpener } from "../components/AvatarViewer";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { useComposition } from "../hooks/useComposition";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { createPortal } from "react-dom";
import { ChatHoldDialog } from "../components/ChatHoldDialog";
import { ContactIdentitiesPanel } from "../components/identities/ContactIdentitiesPanel";
import { FaceCorner, IdentityStack } from "../components/identities/ContactMarks";
import { shownContactName, useChosenProfile, useContactFace } from "../components/identities/contactFace";
import { IdentityShareLine } from "../components/identities/IdentityShareLine";
import { ChatServicesDialog } from "../components/ChatServicesDialog";
import { PinIcon } from "../components/PinIcon";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { useI18n } from "../contexts/I18nContext";
import { InviteCard } from "../components/InviteCard";
import { LinkQrDialog } from "../components/chat/LinkQrDialog";
import { ChatConnection } from "../components/ChatConnection";
import { PairingScene } from "../components/pairing/PairingScene";
import { usePairingProgress } from "../hooks/usePairingProgress";
import { contactArrived } from "../lib/pairingProgress";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { leftOn, useChatScroll } from "../hooks/useChatScroll";
import { useRowWindow } from "../hooks/useRowWindow";
import { JumpToLatest } from "../components/chat/JumpToLatest";
import { useWebRTC } from "../hooks/useWebRTC";
import { useCallDevices } from "../hooks/useCallDevices";
import { preferredDevice } from "../lib/mediaDevices";
import { useSettings } from "../contexts/SettingsContext";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { messageSnippet, quoteFor, replyIndex, replyTarget, sentReply, type NameOf } from "../lib/replies";
import { buttonsViews, compactPresses } from "../lib/buttons";
import { replySnippet, type RoutineCard } from "@ghostly/core";
import { composerServices } from "../components/composer/servicesRow";
import { CallButtons } from "../components/CallButtons";
import { CallOverlay } from "../components/CallOverlay";
import { IncomingCallNotification } from "../components/IncomingCallNotification";
import { contactStatus } from "../lib/contactStatus";
import { callLineId } from "../lib/callLines";
import { PeerServices } from "../components/PeerServices";
import { formatFileSize } from "../lib/format";
import { playSound, startRinging } from "../lib/sounds";
import { CueChat } from "../lib/cues";
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
import { chatPath, inviteShareText } from "../lib/url";
import { continueInNewChat } from "../lib/continueChat";
import { engine } from "@ghostly/browser/platform/engine";
import { fileMessageText, inviteQrSegments, isPlayableVideoType, PAIRED_CALL_CANDIDATES, parseCallSignal, signalHasVideo, type VoiceMeta } from "@ghostly/core";
import { videoMetaOf } from "../lib/videoPoster";
import type { ChatParams, CallEventType, ChatMessage } from "../lib/types";
import type { WalletNetwork } from "../lib/platform";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { MuteMenu, MuteMenuItem } from "../components/ChatMute";
import { MUTE_SILENCES, callRings, useChatMute } from "../lib/chatMute";
import { useWakeCall } from "../hooks/useWakeCall";
import { useIncomingCallNotice } from "../hooks/useIncomingCallNotice";
import { useChatLink } from "../hooks/useChatLink";
import { useTypingSender } from "../hooks/useTyping";
import { ChatSubtitle } from "../components/TypingIndicator";
import { TransportLine } from "../components/TransportTimeline";
import { mergeTimeline } from "../lib/transportEvents";
import { walletCards } from "../components/walletCardData";
import { cardOn } from "../lib/chatPayments";
import { formatAt } from "../lib/time";
import { useForwarding } from "../hooks/useForwarding";
import { useChatSearch } from "../hooks/useChatSearch";
import { ChatSearchBar, SearchIcon } from "../components/chat/ChatSearch";
import { PinnedBar } from "../components/chat/PinnedBar";
import { TasksButton } from "../components/chat/TasksButton";
import { useJumpTo } from "../hooks/useJumpTo";
import { RoutineStack } from "../components/chat/RoutineCard";
import { routineStacks } from "../lib/statusCards";
import { scrollIntoViewGently } from "../lib/motion";
import { MessageAnnouncer } from "../components/chat/MessageAnnouncer";
import { PinMoveItems, PinMoveNote } from "../components/chat/PinOrder";
import { usePinMoveNote } from "../hooks/usePinMoveNote";
import { errorText } from "../lib/errorText";

/** What a call captures from: the devices the profile chose, read when it asks. */
const callDevicePreferences = () => ({ audio: preferredDevice("audioinput"), video: preferredDevice("videoinput") });

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

/**
 * A text of mine this chat can edit (WISP 400 § Edits): one the engine sent under its wire id, not a file, a payment or a
 * notice, nor a status card, which only its bot updates (WISP 405 · Status Cards).
 */
function editableText(message: ChatMessage): boolean {
  return message.sender === "me" && !!message.ref && message.id === `me_${message.ref}` && !message.file && !message.paymentId && !message.systemEvent && !message.callEvent && !message.card;
}

export function Chat({ sessionId, visible, onCallChange, callLayer }: ChatProps) {
  const nav = useAppNavigation();
  const { t, language } = useI18n();
  const { settings } = useSettings();
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
    sendMessage,
    techInfo,
    peerAck,
    forceRefresh,
    incomingCallSignal,
    setCallSignal,
    setChatFastPoll,
    addSystemMessage,
    deleteMessage,
    setNick,
  } = useChat(params);

  // Only what contacts may see: the join notice names nobody while this profile does not share its name.
  useEffect(() => {
    setNick(sharedNick);
  }, [sharedNick, setNick]);

  const addCallEventMessage = useCallback(
    (type: CallEventType, hasVideo: boolean, duration?: number, call?: number) => {
      // Kept in English in the history: the call line is worded in the person's language where it is drawn (MessageBubble).
      const textMap: Record<CallEventType, string> = {
        call_started: hasVideo ? "Video call started" : "Audio call started",
        call_received: hasVideo ? "Incoming video call" : "Incoming audio call",
        call_connected: hasVideo ? "Video call connected" : "Audio call connected",
        call_ended: hasVideo ? "Video call ended" : "Audio call ended",
        call_missed: hasVideo ? "Missed video call" : "Missed audio call",
        call_unanswered: hasVideo ? "Video call, no answer" : "Audio call, no answer",
        call_cancelled: hasVideo ? "Video call cancelled" : "Audio call cancelled",
        call_rejected: hasVideo ? "Video call declined" : "Audio call declined",
        call_failed: hasVideo ? "Video call couldn't connect" : "Audio call couldn't connect",
      };

      const msg: ChatMessage = {
        id: callLineId(type, call),
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
      return msg.id;
    },
    [addSystemMessage],
  );

  const platform = useServicesPlatform();
  const webrtc = useWebRTC({
    incomingCallSignal,
    publishCallSignal: setCallSignal,
    setFastPoll: setChatFastPoll,
    addCallEventMessage,
    // Only a line of this side's own (a call that lost a glare): the contact never had it, so nothing goes out.
    removeCallEventMessage: deleteMessage,
    media: platform?.callMedia?.(),
    // The profile's ICE servers (a TURN relay) serve calls too; a signal on the chat session carries every path.
    iceServers: engine.state?.settings.iceServers,
    maxCandidates: session?.profile === "paired-chat/1" ? PAIRED_CALL_CANDIDATES : undefined,
    // The microphone and camera this profile chose in Settings → Audio & video.
    devices: callDevicePreferences,
  });
  const callDevices = useCallDevices(webrtc);

  const callState = webrtc.callState;
  const previousCallState = useRef(callState);
  useEffect(() => {
    const before = previousCallState.current;
    previousCallState.current = callState;
    // A muted chat still rings (lib/chatMute.ts, MUTE_SILENCES).
    if (callState === "incoming") return callRings(sessionId) ? startRinging("ring") : undefined;
    if (callState === "offering") return startRinging("ringback");
    if (callState === "idle" && before !== "idle") playSound("hangup");
  }, [callState, sessionId]);
  // Out of sight, a ringing call is a system notification too.
  useIncomingCallNotice(callState === "incoming" && callRings(sessionId), sessionId, t("pwa.wakeCall"));

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

  const paired = session?.profile === "paired-chat/1";
  // A chat made with a v0.4 code (WISP 402): kept working both ways, never created by this app.
  const compat = !!session && !paired;
  const deliveryPeer = platform?.getPeer(session?.peerPubKeyB64 ?? "");
  const pairedReady = deliveryPeer?.pairing?.status === "ready";
  // A paired chat calls over its live session (`calls/1`); why it cannot right now, if it cannot.
  const callsBlocked = paired ? (deliveryPeer?.callsUnavailable === undefined ? t("calls.needLive") : deliveryPeer.callsUnavailable) : null;
  // The one chat (WISP 400): live over layer 1, or not; what cannot go now waits (a clock beside its time) or is held.
  const chatLive = pairedReady && deliveryPeer?.dataLink === "open";
  // A security rejection (a stream authenticated another key than the pinned one) stops the chat on both layers until the person acts.
  const chatStop = paired && deliveryPeer?.pairing?.keyMismatch ? deliveryPeer.pairing.error ?? t("chat.keyChanged") : undefined;
  // A chat made here (it has an invite to give) is the inviter's side of the pairing; read once, before the
  // invite code is forgotten when the contact shows up.
  const createdHere = useMemo(() => !!getInviteCode(sessionId), [sessionId]);
  const muted = useChatMute(sessionId) !== undefined;
  const pairing = usePairingProgress(paired ? session?.peerPubKeyB64 : undefined, {
    inviter: createdHere,
    // A DHT-only chat has no live link to wait for: its messages go over the DHT from the start.
    enabled: paired && (deliveryPeer?.deliveryMode ?? session?.deliveryMode) !== "dht",
    createdAt: session?.createdAt,
    muted: muted && MUTE_SILENCES.connected,
  });
  const pairingSceneId = `pairing-${sessionId}`;
  // Once the contact has arrived with the invite (their packet seen, or past the wait), the invite has done its job:
  // its card goes and the scene alone tells the rest. It comes back if the state says nobody is there any more.
  const invitePast = contactArrived(pairing.progress);
  const peerKey = params?.peerPubKeyB64;
  /** The message the composer answers (WISP 400 § Replies): a paired chat's only. */
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  /**
   * The reply as it is when something is sent, not as a render's closure saw it: a recording or a sheet of files
   * started earlier goes with the reply set now. The first thing sent after Reply carries it (a text, a voice note, a
   * file; of several files, the first), and nothing after it does: a caption after its files does not quote again.
   */
  const replyingRef = useRef(replyingTo);
  replyingRef.current = replyingTo;
  /** Sent with the reply: the bar goes, unless another message was chosen meanwhile. */
  const replied = useCallback((answering: ChatMessage) => {
    if (replyingRef.current === answering) replyingRef.current = null;
    setReplyingTo(current => current === answering ? null : current);
  }, [setReplyingTo]);
  const sendFile = useCallback(
    async (source: File, voice?: VoiceMeta): Promise<string | null> => {
      if (!platform || !peerKey) return null;
      const tooLarge = platform.fileTooLarge ? platform.fileTooLarge(peerKey, source.size)
        : source.size > platform.maxFileBytes ? t("chat.fileTooLarge", { size: formatFileSize(platform.maxFileBytes) }) : null;
      if (tooLarge) return tooLarge;
      // A file answers as a text does: the engine keeps the reply and sends it with the file (files/2, files/3, held).
      const answering = paired ? replyingRef.current : null;
      const reply = answering ? sentReply(answering) : undefined;
      try {
        // A video goes with its length, size and first frame, so the contact sees it before it arrives.
        const video = !voice && isPlayableVideoType(source.type) ? await videoMetaOf(source).catch(() => undefined) : undefined;
        const { timestamp, file } = await platform.sendFile(peerKey, source, { voice, ...(video && { video }), ...(answering && reply && { replyTo: answering.id }) });
        // This side's copy quotes it at once, as the engine keeps it: the engine's own row of a file is not copied here.
        addSystemMessage({ id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, file, ...(reply && { replyTo: reply }) });
        if (answering) replied(answering);
        window.dispatchEvent(new Event("session-updated"));
        return null;
      } catch (e) {
        return errorText(e, t);
      }
    },
    [platform, peerKey, paired, addSystemMessage, replied, t],
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
    async (kind: "send" | "request", amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", network?: WalletNetwork, confirmedReal?: boolean, lightningCard?: string): Promise<string | null> => {
      if (!wallet || !peerKey) return null;
      // The card's own wallet: the request or the ecash is of its network, a request's invoice of its Lightning card.
      const onNetwork = network ? wallet.forNetwork(network) : wallet;
      const card = lightningCard ? onNetwork.forLightning(lightningCard) : onNetwork;
      try {
        const { timestamp, paymentId } = await (kind === "request" ? card.request(peerKey, amount, memo || undefined, method) : card.send(peerKey, amount, memo || undefined, confirmedReal));
        const sats = network === "testnet" ? "test sats" : "sats";
        const text = method === "usdt" ? "Token payment request" : kind === "send" ? `⚡ ${amount.toLocaleString()} ${sats}` : `⚡ Requested ${amount.toLocaleString()} ${sats}`;
        addSystemMessage({ id: `me_${timestamp}`, text, sender: "me", timestamp, paymentId });
        window.dispatchEvent(new Event("session-updated"));
        return null;
      } catch (e) {
        return errorText(e, t);
      }
    },
    [wallet, peerKey, addSystemMessage, t],
  );
  const paySend = useCallback((amount: number, memo: string, network?: WalletNetwork, confirmedReal?: boolean) => pay("send", amount, memo, undefined, network, confirmedReal), [pay]);
  const payRequest = useCallback((amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", _rail?: unknown, network?: WalletNetwork, lightningCard?: string) => pay("request", amount, memo, method, network, undefined, lightningCard), [pay]);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [chatLabel, setChatLabel] = useState<string>("");
  const [peerNick, setPeerNick] = useState<string>("");
  const profileNick = usePeerNick(params?.peerPubKeyB64);
  // The identity the contact is shown as, when one was chosen and its proof still stands (identities/contactFace.ts).
  const face = useContactFace(params?.peerPubKeyB64);
  const peerAvatar = usePeerAvatar(params?.peerPubKeyB64);
  useChosenProfile(params?.peerPubKeyB64);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const labelComposition = useComposition();
  const [labelDraft, setLabelDraft] = useState("");
  /** Ways of paying are chosen per chat; the ⚡ works while this device allows at least one. */
  const chatPeer = platform?.getPeer(params?.peerPubKeyB64 ?? "");
  // The chat's link as the engine shows it: its transport lines in the timeline.
  const chatLink = useChatLink(params?.peerPubKeyB64 ?? "");
  // What tells the contact when this side writes (WISP 401 § Typing): 1:1 paired chats only.
  const onTyping = useTypingSender(paired ? chatLink?.id : undefined, visible);
  const timeline = useMemo(() => mergeTimeline(messages, paired ? chatLink?.transportLog ?? [] : [], paired ? chatLink?.identityTimeline ?? [] : []),
    [messages, paired, chatLink?.transportLog, chatLink?.identityTimeline]);
  // Forward, and Select then Forward (WISP 400 § Forwards): texts and files, to other chats and groups.
  const forwarding = useForwarding(chatLink?.id, messages);
  // On while one of this profile's wallets has its card on here; with no wallet yet, while a way of paying is on.
  // Live, and the contact's app says no to payments here (no wallet, off, or too old): its side, not this chat's.
  const contactRefusesPay = paired && chatLive && !chatPeer?.capabilities?.payments;
  const paymentsOn = walletState?.wallets?.length ? walletCards(walletState).some((c) => cardOn(chatPeer ?? undefined, c.rail, c.network)) : !chatPeer?.paymentMethods || Object.values(chatPeer.paymentMethods).some(Boolean);
  const [showHold, setShowHold] = useState(false);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [showIdentities, setShowIdentities] = useState(false);
  /** The card the identities panel opens on: a share tapped in the timeline. */
  const [identityCard, setIdentityCard] = useState<{ side: "mine" | "theirs"; id: string }>();
  /** One of mine tapped in the timeline: the composer's picker opens on it. */
  const [myIdentity, setMyIdentity] = useState<{ id: string; at: number }>();
  const [showServices, setShowServices] = useState(false);
  /** The message of mine the composer edits (WISP 400 § Edits): a paired chat's only. */
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  // Opened from the Tasks board: on the card's message, once it is here.
  useJumpTo(visible, id => messages.some(m => m.id === id));
  const quoteIndex = useMemo(() => replyIndex(messages), [messages]);
  // A bot's buttons (WISP 406 · Message Buttons): which one was chosen, and whether I may still press, from my replies.
  const buttonsOf = useMemo(() => buttonsViews(messages, m => m.ref), [messages]);
  const presses = useMemo(() => compactPresses(messages, m => m.ref), [messages]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMute, setShowMute] = useState(false);
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
    setReplyingTo(null);
    setEditing(null);
  }, [sessionId]);

  const closeMenu = () => setMenuOpen(false);
  const [pinNote, announcePinMove] = usePinMoveNote();
  const techBackdrop = useBackdropDismiss(() => setShowTechInfo(false));

  // A bot's routines in a row: one row, opened on a tap (WISP 405 · Status Cards). Found over the whole timeline, so a
  // run is the same whichever of its rows are in the page.
  const stacks = useMemo(() => routineStacks(timeline, r => r.kind === "message" ? r.message : undefined), [timeline]);
  const stackHeads = useMemo(() => new Map([...stacks.values()].flatMap(run => run.slice(1).map(m => [m.id, run[0].id] as const))), [stacks]);
  // A long chat has a window of its rows in the page, never the whole history (useRowWindow): its last ones, or those
  // around the message it was left on, and more as the view goes up or down.
  const rowIds = useMemo(() => timeline.map(row => row.kind === "message" ? row.message.id : `${row.kind}:${row.entry.id}`), [timeline]);
  const rowWindow = useRowWindow(rowIds, sessionId, { opensOn: leftOn(sessionId), heads: stackHeads });
  // At the bottom a new message keeps the view there; scrolled up, nothing moves it and the ↓ pill counts the contact's.
  // A notice (joined, a call) is not a message to count. Always every message, in the page or not; a new list when the
  // window moves, so the view is put back in the same commit, before a scroll can see the rows moved.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the window's edges: see above
  const scrollRows = useMemo(() => messages.filter(m => m.sender !== "system").map(m => ({ id: m.id, mine: m.sender === "me" })), [messages, rowWindow.from, rowWindow.to]);
  const jump = useChatScroll({ rows: scrollRows, chat: sessionId, keys: visible, window: rowWindow });
  const search = useChatSearch({ messages, chat: sessionId, active: visible });

  // A chat still pairing opens on its scene, not on the bottom of an empty history.
  const sceneOn = pairing.scene;
  useEffect(() => {
    if (sceneOn && messages.length === 0) document.getElementById(pairingSceneId)?.scrollIntoView({ block: "nearest" });
  }, [sceneOn, messages.length, pairingSceneId]);

  // Only what is on screen has been read; a chat kept alive by a call has not.
  useEffect(() => {
    if (visible) markSessionAsRead(sessionId);
  }, [visible, sessionId, messages.length]);

  // The contact's app is closed but it shared how to wake it (WISP 401 § Wake-up push): a call wakes it, then rings.
  const canWakeForCall = paired && !chatLive && !!chatLink?.peerWakes && !!chatLink.id && !chatStop;
  const placeCall = webrtc.startCall;
  const wakeCall = useWakeCall(chatLink?.id, paired && !callsBlocked, placeCall);

  if (!params) {
    // A chat still on a call has nowhere better to be; only the one on screen leaves.
    return visible ? <Navigate to="/" replace /> : null;
  }

  const handleDelete = () => {
    if (confirmDelete) {
      deleteSession(params.sessionId);
      // The chat list keeps its own copy: without this it shows the deleted chat until its next refresh.
      window.dispatchEvent(new Event("session-updated"));
      nav.home();
    } else {
      setConfirmDelete(true);
    }
  };

  const statusLabel = contactStatus(deliveryPeer, paired, status);

  const truncatedPeerKey = publicKeyLabel(params.peerPubKeyB64);
  // What the contact last said on the session wins over a name read out of an older message.
  const contactNick = profileNick !== undefined ? profileNick : peerNick;
  // A nickname given here wins, then the chosen identity's name, then the contact's own, then their key.
  const shown = shownContactName({ nickname: chatLabel, face, nick: contactNick, fallback: t("common.unnamedContact", { key: contactTag(params.peerPubKeyB64) }) });
  const isAnonymous = shown.from === "key";
  const shownName = shown.name;
  // A reply's quote and the composer's bar name the author as this chat does.
  const nameOf: NameOf = (from) => from === "me" ? t("chat.reply.you") : from === "peer" ? shownName : undefined;
  // Reactions (WISP 400 § Reactions): the engine keeps them and tells the contact; a failure leaves the chips as they were.
  const react = (messageId: string, emoji: string) => {
    if (chatLink?.id) void engine.call("react", { linkId: chatLink.id, messageId, emoji }).catch(() => {});
  };
  const reactionName = (by: string) => by === "peer" ? shownName : by.slice(0, 8);
  // The pinned message (WISP 400 § Pinned message): one per chat; the engine keeps it and tells the contact.
  const pin = paired ? chatLink?.pin : undefined;
  const pinMessage = (messageId: string | undefined, remove = false) => {
    if (chatLink?.id) void engine.call("pinMessage", { linkId: chatLink.id, messageId, remove }).catch(() => {});
  };
  const replyBar = replyingTo ? { key: replyingTo.id, name: nameOf(replyingTo.sender === "me" ? "me" : "peer"), snippet: messageSnippet(replyingTo),
    mine: replyingTo.sender === "me", onCancel: () => setReplyingTo(null) } : undefined;
  // Until live: the connection icon tells the pairing; the "connected" moment belongs to the scene.
  const pairingShown = pairing.show && !!pairing.progress && pairing.progress.stage !== "live";

  return (
    // The chat's column, and beside it (over it when narrow) the contact's identities: the page is their container.
    <CueChat.Provider value={sessionId}>
    <div className="chat-pane flex-1 h-full">
    {/* A message that comes while the chat is open, read out once to a screen reader. */}
    <MessageAnnouncer chat={sessionId} messages={messages} nameOf={() => shownName} active={visible} />
    <PinMoveNote text={pinNote} />
    {/* Files dropped anywhere on the column go to the composer (`data-file-drop`). */}
    <div data-file-drop className="chat-column relative flex-1 flex flex-col h-full min-w-0 bg-chat-bg">
      {(wakeCall.waking || wakeCall.gaveUp) && (
        <div role="status" data-testid="wake-call" data-state={wakeCall.waking ? "waking" : "gave-up"}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-text-primary shadow-xl">
          <span>{wakeCall.waking ? t("calls.waking", { name: shownName }) : t("calls.wakeGaveUp", { name: shownName })}</span>
          {wakeCall.waking && <button type="button" onClick={wakeCall.cancel} data-testid="wake-call-cancel" className="text-accent hover:text-accent-hover cursor-pointer">{t("common.cancel")}</button>}
        </div>
      )}
      {/* Our call rang out (RING_MS): it ended by itself, and says why. */}
      {webrtc.noAnswer && (
        <div role="status" data-testid="call-no-answer"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-text-primary shadow-xl">
          {t("calls.noAnswer")}
        </div>
      )}
      {/* A call could not use the microphone or camera (refused, or none there): it says why, and how to fix it. */}
      {webrtc.mediaProblem && (
        <div role="alert" data-testid="call-media-problem" data-problem={webrtc.mediaProblem}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] w-max max-w-[calc(100%-2rem)] rounded-lg border border-border bg-panel-header px-4 py-2 text-center text-sm text-text-primary shadow-xl">
          {t(webrtc.mediaProblem === "denied" ? "calls.mediaDenied" : "calls.mediaUnavailable")}
        </div>
      )}
      {/* Chat Header. On a phone every button can be there at once (the connection, a call, a video call, a bot's Tasks,
          ⋮): the back button, the avatar, the buttons' sides and the gaps are a little narrower there, so the name keeps
          eight characters on a 375px phone (it had a letter or two). The buttons stay as tall, and touch each other. */}
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:ps-1 max-md:pe-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1 min-w-0">
          <button
            onClick={nav.up}
            className="md:hidden w-9 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0"
            title={t("common.back")}
            data-testid="chat-back"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          {/* With a picture, a click opens it large (AvatarViewer.tsx). */}
          <AvatarOpener src={face?.photo ?? peerAvatar} name={shownName} testId="chat-avatar-open"
            className="relative w-10 h-10 max-md:w-9 max-md:h-9 rounded-full bg-surface-hover flex items-center justify-center shrink-0 [--ring:var(--theme-panel-header)]">
            <PeerAvatar peerPubKey={params?.peerPubKeyB64} label={shownName} named={!isAnonymous} photo={face?.photo} testId="chat-avatar" />
            {face && <FaceCorner face={face} />}
            {inviteCode && !pairedReady && (
              <span className="absolute -bottom-0.5 -end-0.5 w-[16px] h-[16px] flex items-center justify-center rounded-full text-[8px] bg-accent text-on-accent z-10 group/star">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
                <span className="absolute top-1/2 -translate-y-1/2 start-full ms-2 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover/star:opacity-100 transition-opacity pointer-events-none shadow-lg border border-border">
                  {t("chat.createdHere")}
                </span>
              </span>
            )}
          </AvatarOpener>
          <div className="min-w-0">
            {isEditingLabel ? (
              <input
                ref={labelInputRef}
                type="text"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                {...labelComposition.inputProps}
                onKeyDown={(e) => {
                  if (labelComposition.composing(e)) return;
                  if (e.key === "Enter") saveLabel();
                  if (e.key === "Escape") setIsEditingLabel(false);
                }}
                onBlur={saveLabel}
                placeholder={t("chat.setName")}
                className="bg-input-bg border-none rounded px-2 py-0.5 text-[15px] text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent w-full max-w-[200px]"
                maxLength={30}
              />
            ) : (
              <div className="flex items-center gap-1.5 max-md:gap-1 min-w-0">
              <p
                onClick={startEditLabel}
                className={`group/name text-[15px] font-normal m-0 leading-tight truncate cursor-pointer hover:text-accent transition-colors ${isAnonymous ? "text-text-muted italic" : "text-text-primary"}`}
                title={t("chat.setNameHint")}
              >
                {/* With no name, the word alone: the start of their key ("Contact · 1kwb54" elsewhere) is on the line
                    right under it, and the whole of it was cut to "Contac…" on a 320px phone. */}
                <bdi data-testid="chat-name">{isAnonymous ? t("common.unnamedContactShort") : shownName}</bdi>
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
                    className="inline ms-1.5 text-text-muted opacity-0 group-hover/name:opacity-100 max-md:hidden"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                )}
              </p>
              {paired && <IdentityStack peerKey={params.peerPubKeyB64} name={shownName} open={showIdentities} onOpen={() => { setIdentityCard(undefined); setShowIdentities(open => !open); }}
                footer={face ? t("chat.shownWith", { provider: face.providerName, key: truncatedPeerKey }) : undefined} />}
              {compat && <span data-testid="compat-chat" title={t("chat.compat.hint")}
                className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] leading-none text-text-muted whitespace-nowrap max-md:hidden">{t("chat.compat.label")}</span>}
              </div>
            )}
            {/* The contact's key, or "typing…" while they write (presence, not connection). Everything about the
                connection, pairing included, is the icon beside the calls. */}
            <ChatSubtitle peerKey={paired ? params.peerPubKeyB64 : undefined} keyLabel={truncatedPeerKey} />
          </div>
        </div>
        <div className="flex items-center gap-1 max-md:gap-0 shrink-0">
          {/* The chat's one connection control: its icon, and one panel with the choice and the rest under Details. */}
          <ChatConnection key={sessionId} peerKey={params.peerPubKeyB64} paired={paired} myKey={techInfo?.myPubKey} status={statusLabel}
            pairing={pairingShown && pairing.progress ? { progress: pairing.progress, onShow: pairing.scene
              ? () => scrollIntoViewGently(document.getElementById(pairingSceneId)) : undefined } : undefined} />
          <CallButtons blocked={webrtc.otherCallOn && webrtc.callState === "idle" ? t("calls.onAnother") : canWakeForCall ? null : callsBlocked} busy={webrtc.callState !== "idle" || wakeCall.waking}
            onCall={(withVideo) => (callsBlocked && canWakeForCall ? void wakeCall.ring(withVideo) : webrtc.startCall(withVideo))} />
          {/* Only while a bot's card is here (WISP 405 · Status Cards). */}
          <TasksButton rows={messages} />
          {/* Options dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-2 max-md:px-1.5 max-md:py-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer"
              title={t("chat.options")}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              data-testid="chat-options"
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
            <Menu testId="chat-options-menu" open={menuOpen} onClose={closeMenu} anchorRef={menuRef}>
              <MenuItem testId="chat-pin-toggle" onClick={() => { setSessionPinned(sessionId, !isSessionPinned(sessionId)); closeMenu(); }} icon={<PinIcon active={isSessionPinned(sessionId)} />}>
                {isSessionPinned(sessionId) ? t("chat.menu.unpin") : t("chat.menu.pin")}
              </MenuItem>
              <PinMoveItems chat={sessionId} onMoved={place => { announcePinMove(place); closeMenu(); }} />
              <MuteMenuItem chat={sessionId} onChoose={() => { closeMenu(); setShowMute(true); }} onDone={closeMenu} />
              <MenuItem testId="chat-search-open" onClick={() => { closeMenu(); search.show(); }} icon={<SearchIcon />}>{t("chat.search.open")}</MenuItem>
              {/* Until the contact's session is ready, not just while the card is up: the card goes as soon as the
                  contact arrives, and this stays the way to copy the invite again until the chat is live. */}
              {inviteCode && !pairedReady && (
                <MenuItem testId="chat-copy-invite" onClick={() => { handleCopyCode(inviteShareText(inviteCode)); closeMenu(); }}
                  icon={codeCopied
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><polyline points="20 6 9 17 4 12" /></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>}>
                  {codeCopied ? t("common.copied") : t("sidebar.copyInvite")}
                </MenuItem>
              )}
              {/* The invite card and its QR go with the first message: until the chat is live this shows the QR again. */}
              {inviteCode && !pairedReady && (
                <MenuItem testId="chat-invite-qr" onClick={() => { setShowInviteQr(true); closeMenu(); }}
                  icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v.01M21 21v.01M17 21h.01M21 17.5v.01" /></svg>}>
                  {t("invite.qrTitle")}
                </MenuItem>
              )}
              {paired && platform?.getPeer(params.peerPubKeyB64) && (
                <MenuItem testId="chat-hold-open" onClick={() => { setShowHold(true); closeMenu(); }}
                  icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>}>
                  {t("chat.menu.hold")}
                </MenuItem>
              )}
              {compat && (
                <MenuItem testId="chat-continue-new" onClick={() => {
                  closeMenu();
                  void continueInNewChat(sessionId).then(next => {
                    if (next) void sendMessage(next.message).finally(() => nav.conversation(chatPath(next.sessionId)));
                  });
                }}
                  icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5" /><path d="M16 19h6m-3-3 3 3-3 3" /></svg>}>
                  {t("chat.menu.continueNew")}
                </MenuItem>
              )}
              <MenuItem onClick={() => { forceRefresh(); closeMenu(); }}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" /></svg>}>
                {t("chat.menu.refresh")}
              </MenuItem>
              <MenuItem onClick={() => { setShowTechInfo(true); closeMenu(); }}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>}>
                {t("chat.menu.techInfo")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onClick={() => { setConfirmDelete(true); closeMenu(); }}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>}>
                {t("sidebar.deleteChat")}
              </MenuItem>
            </Menu>
            <MuteMenu chat={sessionId} open={showMute} onClose={() => setShowMute(false)} anchorRef={menuRef} />
          </div>
        </div>
      </div>

      <ChatSearchBar search={search} />
      <PinnedBar pin={pin} index={quoteIndex} onUnpin={() => pinMessage(undefined, true)} />

      <PeerServices peerPubKey={params.peerPubKeyB64} showLink={!paired} onManage={() => setShowServices(true)} />

      {compat && session?.continuedIn && (
        <div data-testid="compat-continued" className="flex items-center justify-center gap-2 bg-panel-header/60 px-4 py-1.5 text-xs text-text-secondary">
          <span>{t("chat.compat.continued")}</span>
          <button type="button" className="underline text-accent cursor-pointer" onClick={() => nav.conversation(chatPath(session.continuedIn!))}>{t("chat.compat.open")}</button>
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={jump.listRef} data-message-list className="flex-1 overflow-y-auto [overflow-anchor:none] chat-wallpaper">
        {/* A bubble arriving slides in from its side: clipped here, it never makes the list scroll sideways (a scrollbar, and a jump). */}
        <div ref={jump.columnRef} className="max-w-3xl mx-auto py-3 overflow-x-clip">
          {session?.createdAt && Number.isFinite(session.createdAt) && session.createdAt > 0 && (
            <p data-testid="chat-created" className="mb-3 px-4 text-center text-[11px] text-text-muted">
              <time dateTime={new Date(session.createdAt).toISOString()}>
                {t("common.chatCreated", {date: new Intl.DateTimeFormat(language, {dateStyle:"medium", timeStyle:"short"}).format(session.createdAt)})}
              </time>
            </p>
          )}
          {/* The scene and the invite it waits on: side by side where the column has room for both. */}
          <div className="pairing-invite"><div className="pairing-invite-row">
          {pairing.scene && pairing.progress && (
            <PairingScene id={pairingSceneId} progress={pairing.progress} contact={shownName}
              retry={() => void pairing.retry()} retrying={pairing.retrying} retryError={pairing.retryError} />
          )}
          {inviteCode && (
            <InviteCard code={inviteCode} shown={!pairedReady && !invitePast && messages.length === 0} />
          )}
          </div></div>
          {!inviteCode && !pairing.show && messages.length === 0 && (
            <div className="flex items-center justify-center min-h-[200px]">
              <div className="bg-surface-alt/90 rounded-lg px-4 py-2 text-center">
                <p className="text-text-muted text-xs">
                  {t("chat.empty")}
                </p>
              </div>
            </div>
          )}
          {(() => {
            const drawn = timeline.slice(rowWindow.from, rowWindow.to);
            const draw = (row: (typeof drawn)[number]) => row.kind === "transport"
              ? <TransportLine key={`transport:${row.entry.id}`} entry={row.entry} earlier={row.earlier} contact={shownName} />
              : row.kind === "identity"
              ? <IdentityShareLine key={`identity:${row.entry.id}`} entry={row.entry} link={chatLink} contact={shownName}
                onOpen={e => {
                  // Theirs: the contact's panel on that card. Mine: the composer's picker on it, where mine are shared.
                  if (e.side === "mine") { setShowIdentities(false); setMyIdentity({ id: e.proof, at: Date.now() }); return; }
                  setIdentityCard({ side: e.side, id: e.proof }); setShowIdentities(true);
                }} />
              : (
              <MessageBubble
                key={row.message.id}
                message={row.message}
                peerAck={peerAck}
                peerPubKey={params.peerPubKeyB64}
                peerNick={contactNick}
                contactName={isAnonymous ? "" : shownName}
                onDelete={() => forgetMessage(row.message.id)}
                // Only a paired chat carries replies; a compatibility chat's contact would see the text alone.
                onReply={paired && replyTarget(row.message) ? () => { setEditing(null); setReplyingTo(row.message); } : undefined}
                onEdit={paired && chatLink && editableText(row.message) ? () => { setReplyingTo(null); setEditing(row.message); } : undefined}
                quote={paired && row.message.replyTo ? quoteFor(row.message.replyTo, quoteIndex, nameOf) : undefined}
                // A press is a reply: only a paired chat carries one.
                buttons={paired ? buttonsOf.get(row.message.id) : undefined}
                compactPress={paired && presses.has(row.message.id)}
                linkId={paired ? chatLink?.id : undefined}
                // The same: a compatibility chat has no room for a reaction.
                onReact={paired && replyTarget(row.message) ? emoji => react(row.message.id, emoji) : undefined}
                onPin={paired && replyTarget(row.message) ? () => pinMessage(row.message.id, replyTarget(row.message) === pin?.id) : undefined}
                pinned={!!pin && replyTarget(row.message) === pin.id}
                reactionName={reactionName}
                highlight={search.highlight(row.message.id)}
                {...forwarding.rowProps(row.message)}
              />
            );
            return drawn.map(row => {
              if (row.kind !== "message") return draw(row);
              if (stackHeads.has(row.message.id)) return null;
              const run = stacks.get(row.message.id);
              if (!run) return draw(row);
              return <RoutineStack key={`stack:${row.message.id}`} mine={row.message.sender === "me"} cards={run.map(m => m.card as RoutineCard)}>
                {run.map(message => draw({ kind: "message", message }))}
              </RoutineStack>;
            });
          })()}
        </div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
      </div>

      {chatPeer?.hold && (chatPeer.hold.outstanding > 0 || chatPeer.hold.error) && (
        <div data-testid="hold-indicator" className="px-4 py-1 text-[11px] text-text-secondary bg-surface-alt/60 border-t border-border truncate" role="status">
          {chatPeer.hold.outstanding > 0 && t(chatPeer.hold.outstanding === 1 ? "chat.hold.heldOne" : "chat.hold.heldMany", {
            count: chatPeer.hold.outstanding, name: shownName,
            used: new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(chatPeer.hold.bytes / 1024 / 1024),
            max: new Intl.NumberFormat(language).format(Math.round(chatPeer.hold.maxBytes / 1024 / 1024)) })}
          {chatPeer.hold.outstanding > 0 && chatPeer.hold.error && " · "}
          {chatPeer.hold.error && <span className="text-danger">{errorText(chatPeer.hold.error, t)}</span>}
        </div>
      )}

      {/* Input; while messages are chosen, what to do with them. */}
      {forwarding.bar}
      {forwarding.dialog}
      <div className={forwarding.selecting ? "hidden" : "contents"}>
      <MessageInput draftId={sessionId}
        key={sessionId}
        // Said to the contact on the live session only; stops when the text goes, the chat is left or the page is hidden.
        onTyping={paired ? onTyping : undefined}
        // A paired chat has no mentions; a link preview made in the composer goes with the text, and so does a reply.
        onSend={async (text, _mentions, extra) => {
          const answering = replyingRef.current;
          const error = await sendMessage(text, answering ? { ...extra, replyTo: answering.id } : extra);
          if (!error && answering) replied(answering);
          return error;
        }}
        reply={replyBar}
        // Editing one of mine (WISP 400 § Edits): the new text shows here at once and reaches the contact when it can.
        edit={editing && chatLink ? { key: editing.id, text: editing.text, snippet: replySnippet(editing.text), onClose: () => setEditing(null),
          onSave: async (text, extra) => (await engine.call("editMessage", { linkId: chatLink.id, messageId: editing.id, text, ...(extra?.preview && { preview: extra.preview }) })
            .catch((e: unknown) => ({ error: e instanceof Error ? errorText(e, t) : t("chat.editFailed") }))).error } : undefined}
        onEditLast={paired && chatLink ? () => {
          const last = [...messages].reverse().find(editableText);
          if (last) { setReplyingTo(null); setEditing(last); }
        } : undefined}
        // Ghostly offline, or a security stop: nothing can go. Otherwise what cannot go now waits. Never closed while a
        // message goes: off the live link that is the DHT publication, seconds, and what was typed then went nowhere.
        // The composer sends one at a time itself, and an Enter pressed meanwhile goes next.
        disabled={paired && (!!chatStop || engine.state?.settings.online === false)}
        disabledPlaceholder={t("chat.disabledPlaceholder")}
        // The DHT carries a few hundred characters; the direct link has room for long invoices and ecash tokens.
        softBytes={paired && !chatLive ? deliveryPeer?.dhtDelivery?.maxTextBytes ?? 256 : undefined}
        maxLength={paired ? 16_384 : platform?.getPeer(params.peerPubKeyB64)?.dataLink === "open" ? 4000 : undefined}
        onSendFile={platform ? sendFile : undefined}
        fileUnavailable={paired ? chatStop ?? (chatLive && !platform?.getPeer(params.peerPubKeyB64)?.capabilities?.files ? t("chat.filesNeedUpdate") : undefined) : undefined}
        // The + → Payment row still opens on these: its Accept side is where this chat's ways of paying are chosen.
        paymentsUnavailable={!paymentsOn ? t("chat.payments.off") : chatStop ? chatStop : contactRefusesPay ? (chatPeer?.capabilities?.networks && !Object.keys(chatPeer.capabilities.networks).length ? t("chat.payments.noWallet") : t("chat.payments.offOrOld")) : undefined}
        paymentsUnavailableContact={paymentsOn && !chatStop && contactRefusesPay}
        payments={
          walletState && wallet && peerKey
            ? { balance: walletState.balance, contact: isAnonymous ? undefined : shownName, onSend: paySend, onRequest: payRequest,
              // Paying needs live: a bearer token never waits in a queue or a hold. A request can wait.
              sendUnavailable: paired && !chatLive ? t("chat.payments.needLive") : undefined, reviewContext:platform?.getPeer(peerKey)?.id ? {wallet,peer:peerKey,linkId:platform.getPeer(peerKey)!.id!}:undefined,
              // Which ways this chat accepts: chosen on the composer's Accept side, for this chat only.
              onSaveMethods: chatPeer && platform ? ({ methods, networks }) => platform.setChatPaymentMethods(peerKey, methods, networks) : undefined }
            : undefined
        }
        identities={paired ? { peerKey: params.peerPubKeyB64, contact: shownName, open: myIdentity } : undefined}
        // Made on this device and sent with the text; the contact's app never contacts the site (WISP 401).
        linkPreviews={paired && settings.linkPreviews}
        // The apps this contact and you share, chosen per chat: always reachable here, even before anything is shared.
        services={composerServices(t, platform, params.peerPubKeyB64, shownName, () => setShowServices(true))}
      />
      </div>

      {/* Incoming call notification */}
      {/* Incoming call notification: over whatever is on screen, since this chat may not be. */}
      {webrtc.callState === "incoming" && createPortal(
        <IncomingCallNotification
          peerName={shownName}
          hasVideo={incomingHasVideo}
          onAcceptAudio={() => { webrtc.acceptCall(false); if (!visible) nav.conversation(chatPath(sessionId)); }}
          onAcceptVideo={() => { webrtc.acceptCall(true); if (!visible) nav.conversation(chatPath(sessionId)); }}
          onReject={webrtc.rejectCall}
          // On a call in another chat: End and answer ends it first (useWebRTC), or Decline. Never two calls at once.
          onCall={webrtc.otherCallOn}
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
          onReturnToChat={() => nav.conversation(chatPath(sessionId))}
          callState={webrtc.callState}
          localStream={webrtc.localStream}
          remoteStream={webrtc.remoteStream}
          isMuted={webrtc.isMuted}
          isVideoOff={webrtc.isVideoOff}
          isScreenSharing={webrtc.isScreenSharing}
          canSendVideo={webrtc.canSendVideo}
          canShareScreen={webrtc.canShareScreen}
          screenShareUnavailable={webrtc.screenShareUnavailable}
          screenShareError={webrtc.screenShareError}
          remoteHasVideo={webrtc.remoteHasVideo}
          remoteIsScreenSharing={webrtc.remoteIsScreenSharing}
          callStartedAt={webrtc.callStartedAt}
          reconnecting={webrtc.reconnecting}
          peerName={shownName}
          onHangUp={() => webrtc.hangUp()}
          onToggleMute={webrtc.toggleMute}
          onToggleVideo={webrtc.toggleVideo}
          onToggleScreenShare={webrtc.toggleScreenShare}
          devices={callDevices}
        />
      )}

      {showServices && params && (
        <ChatServicesDialog peerPubKey={params.peerPubKeyB64} name={shownName} onClose={() => setShowServices(false)} />
      )}
      {showInviteQr && inviteCode && !pairedReady && (
        <LinkQrDialog title={t("invite.title")} url={inviteShareText(inviteCode)} qr={inviteQrSegments(inviteCode)} onClose={() => setShowInviteQr(false)} />
      )}
      {showHold && chatPeer && params && platform && (
        <ChatHoldDialog peer={chatPeer} name={shownName} onClose={() => setShowHold(false)}
          onSave={(enabled) => platform.setChatHold(params.peerPubKeyB64, enabled)} />
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
              <h2 className="text-lg font-semibold text-text-primary">{t("chat.menu.techInfo")}</h2>
              <button
                onClick={() => setShowTechInfo(false)}
                aria-label={t("common.close")}
                className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded-full transition-colors"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-4 space-y-4 text-sm">
              <TechInfoSection title={t("chat.tech.identity")}>
                <TechInfoRow label={t("chat.tech.sessionId")} value={techInfo.sessionId} mono copyable />
                <TechInfoRow label={t("chat.tech.myKey")} value={techInfo.myPubKey} mono copyable />
                <TechInfoRow label={t("chat.tech.peerKey")} value={techInfo.peerPubKey} mono copyable />
                <TechInfoRow label={t("chat.tech.encKey")} value={techInfo.encKeyPreview} mono />
              </TechInfoSection>
              <TechInfoSection title={t("chat.tech.protocol")}>
                <TechInfoRow label={t("chat.tech.network")} value={techInfo.protocol} />
                <TechInfoRow label={t("chat.tech.encryption")} value={techInfo.encryption} />
                <TechInfoRow label="TTL" value={`${techInfo.messageTtl}s`} />
                <TechInfoRow label={t("chat.tech.created")} value={formatAt(techInfo.createdAt, { dateStyle: "short", timeStyle: "medium" }, language)} />
              </TechInfoSection>
              <TechInfoSection title={t("chat.tech.sync")}>
                <TechInfoRow label={t("chat.tech.status")} value={status} />
                <TechInfoRow label={t("chat.tech.pollInterval")} value={`${techInfo.currentPollInterval / 1000}s`} />
                <TechInfoRow label={t("chat.tech.polls")} value={techInfo.pollCount.toString()} />
                <TechInfoRow label={t("chat.tech.lastSync")} value={lastSync ? formatAt(lastSync, { timeStyle: "medium" }, language) : "—"} />
                <TechInfoRow label={t("chat.tech.messages")} value={messages.length.toString()} />
              </TechInfoSection>
              <TechInfoSection title={t("chat.tech.ackStatus")}>
                <TechInfoRow 
                  label={t("chat.tech.myAck")} 
                  value={techInfo.myAck > 0 ? formatAt(techInfo.myAck, { timeStyle: "medium" }, language) : t("chat.tech.none")} 
                />
                <TechInfoRow 
                  label={t("chat.tech.peerAck")} 
                  value={techInfo.peerAck > 0 ? formatAt(techInfo.peerAck, { timeStyle: "medium" }, language) : t("chat.tech.none")} 
                />
                <TechInfoRow label={t("chat.tech.pendingBuffer")} value={t("chat.tech.pendingCount", { count: techInfo.sentBufferSize })} />
              </TechInfoSection>
            </div>
          </div>
        </div>
      )}
    </div>
    {showIdentities && params && (
      <ContactIdentitiesPanel key={identityCard ? `${identityCard.side}:${identityCard.id}` : "panel"} peerKey={params.peerPubKeyB64} name={shownName}
        card={identityCard} onClose={() => setShowIdentities(false)} />
    )}
    </div>
    </CueChat.Provider>
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
  const { t } = useI18n();

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
          title={t("chat.message.copyHint")}
        >
          {copied ? t("common.copied") : value}
        </button>
      ) : (
        <span className={`text-text-secondary text-end break-all ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      )}
    </div>
  );
}
