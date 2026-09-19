import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as Desktop from "../../../../src/hooks/useChat";
import {
  addMessage,
  getInviteCode,
  hasAnnouncedJoin,
  loadSession,
  markJoinAnnounced,
  saveSession,
} from "../../../../src/lib/storage";
import type { ChatMessage, ChatTechInfo, ConnectionStatus } from "../../../../src/lib/types";
import { engine } from "./engine";
import { notifySessionsChanged, startSessionSync } from "./sync";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const getState = () => engine.state;

/**
 * Stands in for Desktop's `useChat`. Same contract towards the Chat page, but
 * the Pkarr loop it used to run lives in the peer (`LinkSession` in
 * `@ghostly/core`, a port of that very loop), so it keeps running when no
 * page is open. The session in localStorage is kept exactly as Desktop keeps it.
 */
export const useChat: typeof Desktop.useChat = (params) => {
  const state = useSyncExternalStore(subscribe, getState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isBurned, setIsBurned] = useState(false);
  const [incomingCallSignal, setIncomingCallSignal] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const seedB64 = params?.seedB64;
  const peerPubKey = params?.peerPubKeyB64;
  const encKeyB64 = params?.encKeyB64;
  const sessionId = params?.sessionId ?? "";
  const link = peerPubKey ? state?.links.find((l) => l.peerPubKeyZ32 === peerPubKey) : undefined;
  const linkId = link?.id;

  const nickRef = useRef(params?.nick);
  nickRef.current = params?.nick;
  const linkIdRef = useRef(linkId);
  linkIdRef.current = linkId;
  const createdAtRef = useRef(Date.now());

  const reload = useCallback(() => {
    if (sessionId) setMessages([...(loadSession(sessionId)?.messages ?? [])]);
  }, [sessionId]);

  // The session exists from the moment the chat is opened, as on Desktop.
  useEffect(() => {
    if (!seedB64 || !peerPubKey || !encKeyB64) return;
    startSessionSync();
    const existing = loadSession(sessionId);
    if (existing) {
      createdAtRef.current = existing.createdAt;
    } else {
      createdAtRef.current = Date.now();
      saveSession({
        id: sessionId,
        mySeedB64: seedB64,
        peerPubKeyB64: peerPubKey,
        encKeyB64,
        messages: [],
        createdAt: createdAtRef.current,
      });
      notifySessionsChanged();
    }
    setIsBurned(false);
    setIncomingCallSignal(null);
    reload();
    void engine.call("ensureLink", { seedB64, peerPubKeyZ32: peerPubKey, encKeyB64 }).catch(() => {});
  }, [seedB64, peerPubKey, encKeyB64, sessionId, reload]);

  useEffect(() => {
    window.addEventListener("session-updated", reload);
    return () => window.removeEventListener("session-updated", reload);
  }, [reload]);

  useEffect(() => {
    if (!linkId) return;
    void engine.call("setActiveLink", { linkId }).catch(() => {});
    const off = engine.onCallSignal((id, signal) => id === linkId && setIncomingCallSignal(signal));
    return () => {
      off();
      void engine.call("setActiveLink", { linkId: null }).catch(() => {});
    };
  }, [linkId]);

  const publish = useCallback(
    async (message: ChatMessage): Promise<string | null> => {
      const updated = addMessage(sessionId, message);
      if (updated) setMessages([...updated.messages]);
      notifySessionsChanged();
      // Typing can be faster than the peer taking the link on; `ensureLink` is idempotent.
      const id =
        linkIdRef.current ??
        (seedB64 && peerPubKey && encKeyB64
          ? (await engine.call("ensureLink", { seedB64, peerPubKeyZ32: peerPubKey, encKeyB64 })).linkId
          : undefined);
      if (!id) return "Ghostly is still starting. Try again in a moment.";
      const { error } = await engine.call("sendMessage", {
        linkId: id,
        text: message.text,
        timestamp: message.timestamp,
      });
      return error;
    },
    [sessionId, seedB64, peerPubKey, encKeyB64],
  );

  // "👋 joined": the joiner announces itself once, the creator answers once.
  const announce = useCallback(() => {
    const timestamp = Date.now();
    const nick = nickRef.current;
    const myPubKey = engine.state?.links.find((l) => l.id === linkIdRef.current)?.myPubKeyZ32;
    void publish({
      id: `me_${timestamp}`,
      text: nick ? `👋 ${nick} joined` : "👋 joined",
      sender: "system",
      timestamp,
      nick,
      systemEvent: { type: "join", pubKey: myPubKey },
    });
  }, [publish]);

  useEffect(() => {
    if (!linkId || !sessionId || getInviteCode(sessionId)) return;
    if (hasAnnouncedJoin(sessionId)) return;
    markJoinAnnounced(sessionId);
    announce();
  }, [linkId, sessionId, announce]);

  useEffect(() => {
    if (!linkId || !sessionId || !getInviteCode(sessionId)) return;
    const peerJoined = messages.some((m) => m.id.startsWith("peer_") && m.systemEvent?.type === "join");
    const welcomed = messages.some((m) => m.id.startsWith("me_") && m.systemEvent?.type === "join");
    if (peerJoined && !welcomed) announce();
  }, [linkId, sessionId, messages, announce]);

  const sendMessage = useCallback(
    async (text: string): Promise<string | null> => {
      if (isBurned) return "Chat has been burned";
      const trimmed = text.trim();
      if (!trimmed) return null;
      setIsSending(true);
      try {
        const timestamp = Date.now();
        const open = engine.state?.links.find((l) => l.id === linkIdRef.current)?.dataLink === "open";
        return await publish({
          id: `me_${timestamp}`,
          text: trimmed,
          sender: "me",
          timestamp,
          nick: nickRef.current,
          meta: {
            dhtKey: engine.state?.links.find((l) => l.id === linkIdRef.current)?.myPubKeyZ32 ?? "",
            encryptedPayloadLength: 0,
            dnsRecords: open ? ["webrtc"] : ["_msgs", "_ts", "_ack", ...(nickRef.current ? ["_nick"] : [])],
            packetTimestamp: timestamp,
          },
        });
      } catch (error) {
        return error instanceof Error ? error.message : "Failed to send message. Check your connection.";
      } finally {
        setIsSending(false);
      }
    },
    [isBurned, publish],
  );

  const burn = useCallback(() => setIsBurned(true), []);

  const setNick = useCallback((nick: string) => {
    nickRef.current = nick || undefined;
    if (engine.state && engine.state.settings.nick !== nick) {
      void engine.call("updateSettings", { settings: { nick } }).catch(() => {});
    }
  }, []);

  const setCallSignal = useCallback(async (signal: string | null) => {
    if (linkIdRef.current) await engine.call("setCallSignal", { linkId: linkIdRef.current, signal }).catch(() => {});
  }, []);

  const setChatFastPoll = useCallback((fast: boolean) => {
    if (linkIdRef.current) void engine.call("setFastPoll", { linkId: linkIdRef.current, fast }).catch(() => {});
  }, []);

  const forceRefresh = useCallback(() => {
    if (linkIdRef.current) void engine.call("pollNow", { linkId: linkIdRef.current }).catch(() => {});
  }, []);

  const addSystemMessage = useCallback(
    (message: ChatMessage) => {
      const updated = addMessage(sessionId, message);
      if (updated) setMessages([...updated.messages]);
    },
    [sessionId],
  );

  // The countdown ring next to the peer's key.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const poll = link?.poll;
  const pollCountdown = {
    remaining: poll ? Math.max(0, poll.nextAt - now) : 0,
    total: poll?.interval || 1,
    isPolling: poll?.polling ?? true,
  };

  let status: ConnectionStatus = "connecting";
  if (isBurned || state?.settings.online === false) status = "offline";
  else if (link) status = link.status;

  const techInfo: ChatTechInfo = {
    sessionId,
    myPubKey: link?.myPubKeyZ32 ?? "",
    peerPubKey: peerPubKey ?? "",
    encKeyPreview: encKeyB64 ? `${encKeyB64.slice(0, 8)}...${encKeyB64.slice(-4)}` : "",
    pollCount: 0,
    currentPollInterval: poll?.interval ?? 0,
    republishInterval: 4 * 60_000,
    messageTtl: 300,
    protocol:
      link?.dataLink === "open"
        ? "WebRTC DataChannel (peer to peer) · Pkarr for discovery"
        : (state?.transport.protocol ?? ""),
    encryption: "NaCl secretbox (XSalsa20-Poly1305)",
    relays: state?.transport.relays ?? [],
    createdAt: createdAtRef.current,
    myAck: 0,
    peerAck: link?.peerAck ?? 0,
    sentBufferSize: 0,
  };

  return {
    messages,
    status,
    lastSync: link?.lastSyncAt || null,
    isSending,
    sendMessage,
    burn,
    setNick,
    isBurned,
    techInfo,
    peerAck: link?.peerAck ?? 0,
    forceRefresh,
    incomingCallSignal,
    setCallSignal,
    setChatFastPoll,
    addSystemMessage,
    pollCountdown,
  };
};
