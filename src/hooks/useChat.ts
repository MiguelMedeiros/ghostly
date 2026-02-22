import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ChatMessage,
  ChatParams,
  ConnectionStatus,
  ChatTechInfo,
} from "../lib/types";
import {
  getPublicKeyFromSeed,
  publishMessages,
  resolveMessages,
} from "../lib/pkarr";
import type { CompactMessage } from "../lib/pkarr";
import {
  loadSession,
  saveSession,
  addMessage,
  generateSessionId,
  getInviteCode,
} from "../lib/storage";

const POLL_INTERVAL_ACTIVE = 2_000;
const POLL_INTERVAL_IDLE = 8_000;
const POLL_INTERVAL_FAST = 1_000;
const REPUBLISH_INTERVAL = 30 * 60 * 1000;
const IDLE_THRESHOLD = 60_000;
const MESSAGE_TTL = 300;
const MAX_DHT_TEXT_BYTES = 500;

export function useChat(params: ChatParams | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [peerAck, setPeerAck] = useState<number>(0);
  const [isBurned, setIsBurned] = useState(false);
  const [incomingCallSignal, setIncomingCallSignal] = useState<string | null>(
    null,
  );

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const republishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const burnedRef = useRef(false);
  const sessionIdRef = useRef<string>("");
  const lastSeenTimestampRef = useRef<number>(0);
  const pollCountRef = useRef(0);
  const sentBufferRef = useRef<CompactMessage[]>([]);
  const myAckRef = useRef<number>(0);
  const effectIdRef = useRef<number>(0);

  const seedB64Ref = useRef<string>("");
  const peerPubKeyZ32Ref = useRef<string>("");
  const encKeyB64Ref = useRef<string>("");
  const nickRef = useRef<string | undefined>(undefined);
  const myPubKeyRef = useRef<string>("");
  const sessionCreatedAtRef = useRef<number>(Date.now());
  const pollFnRef = useRef<(() => Promise<void>) | null>(null);
  const isPollingRef = useRef(false);
  const callSignalOutRef = useRef<string | null>(null);
  const doPublishRef = useRef<(() => Promise<void>) | null>(null);
  const fastPollRef = useRef(false);
  const joinMessageSentRef = useRef(false);

  useEffect(() => {
    if (!params) return;

    const currentEffectId = ++effectIdRef.current;

    seedB64Ref.current = params.seedB64;
    peerPubKeyZ32Ref.current = params.peerPubKeyB64;
    encKeyB64Ref.current = params.encKeyB64;
    lastActivityRef.current = Date.now();

    let cancelled = false;

    const init = async () => {
      const myPubKey = await getPublicKeyFromSeed(params.seedB64);
      if (cancelled) return;
      myPubKeyRef.current = myPubKey;
      console.log("[chat] init — my pubkey:", myPubKey.slice(0, 12) + "...");
      console.log(
        "[chat] init — peer pubkey:",
        params.peerPubKeyB64.slice(0, 12) + "...",
      );

      const sessionId = generateSessionId(
        params.seedB64,
        params.peerPubKeyB64,
      );
      sessionIdRef.current = sessionId;

      const existing = loadSession(sessionId);
      if (existing) {
        setMessages(existing.messages);
        const maxPeerTs = existing.messages.reduce(
          (max, m) =>
            m.sender === "peer" ? Math.max(max, m.timestamp) : max,
          0,
        );
        lastSeenTimestampRef.current = maxPeerTs;
        myAckRef.current = maxPeerTs;
        sentBufferRef.current = [];
      } else {
        const now = Date.now();
        sessionCreatedAtRef.current = now;
        
        const isCreator = !!getInviteCode(sessionId);
        
        saveSession({
          id: sessionId,
          mySeedB64: params.seedB64,
          peerPubKeyB64: params.peerPubKeyB64,
          encKeyB64: params.encKeyB64,
          messages: [],
          createdAt: now,
        });
        setMessages([]);
        lastSeenTimestampRef.current = 0;
        sentBufferRef.current = [];
        myAckRef.current = 0;
        
        if (!isCreator) {
          joinMessageSentRef.current = false;
        }
      }

      burnedRef.current = false;
      setIsBurned(false);
      pollCountRef.current = 0;
      setStatus("online");

      const doPublish = async () => {
        if (burnedRef.current || effectIdRef.current !== currentEffectId)
          return;
        const callSig = callSignalOutRef.current ?? undefined;
        console.log("[chat] doPublish - callSignal:", callSig ? `${callSig.slice(0, 30)}...` : "none");
        await publishMessages(
          seedB64Ref.current,
          sentBufferRef.current,
          encKeyB64Ref.current,
          myAckRef.current,
          nickRef.current,
          callSig,
        );
      };
      doPublishRef.current = doPublish;

      if (myAckRef.current > 0) {
        doPublish().catch((err) =>
          console.error("[chat] initial publish error:", err),
        );
      }

      const sendJoinMessage = async () => {
        if (joinMessageSentRef.current) return;
        if (burnedRef.current || effectIdRef.current !== currentEffectId) return;
        
        const isCreator = !!getInviteCode(sessionId);
        if (isCreator) return;
        
        joinMessageSentRef.current = true;
        
        const timestamp = Date.now();
        const joinText = "👋 joined";
        
        const joinMsg: ChatMessage = {
          id: `me_${timestamp}`,
          text: joinText,
          sender: "system",
          timestamp,
          nick: nickRef.current,
          systemEvent: {
            type: "join",
            pubKey: myPubKey,
          },
        };
        
        const updated = addMessage(sessionId, joinMsg);
        if (updated) {
          setMessages([...updated.messages]);
        }
        
        sentBufferRef.current = [
          ...sentBufferRef.current,
          { t: timestamp, m: joinText },
        ];
        
        try {
          await publishMessages(
            seedB64Ref.current,
            sentBufferRef.current,
            encKeyB64Ref.current,
            myAckRef.current,
            nickRef.current,
          );
          console.log("[chat] join message sent");
        } catch (err) {
          console.error("[chat] failed to send join message:", err);
        }
      };
      
      sendJoinMessage();

      const poll = async () => {
        if (burnedRef.current || effectIdRef.current !== currentEffectId)
          return;
        if (isPollingRef.current) return;
        isPollingRef.current = true;

        const n = ++pollCountRef.current;
        try {
          const batch = await resolveMessages(
            peerPubKeyZ32Ref.current,
            encKeyB64Ref.current,
          );

          if (effectIdRef.current !== currentEffectId) return;

          let receivedNew = false;

          if (batch) {
            if (batch.peerAck > 0) {
              const before = sentBufferRef.current.length;
              sentBufferRef.current = sentBufferRef.current.filter(
                (m) => m.t > batch.peerAck,
              );
              if (before !== sentBufferRef.current.length) {
                console.log(
                  `[chat] poll #${n}: peer ACKed, buffer ${before}→${sentBufferRef.current.length}`,
                );
              }
              setPeerAck(batch.peerAck);
            }

            if (
              batch.latestTimestamp > 0 &&
              batch.latestTimestamp > lastSeenTimestampRef.current
            ) {
              const newMsgs = batch.messages.filter(
                (m) => m.timestamp > lastSeenTimestampRef.current,
              );
              console.log(`[chat] poll #${n}: ${newMsgs.length} NEW msg(s)`);

              lastSeenTimestampRef.current = batch.latestTimestamp;
              myAckRef.current = batch.latestTimestamp;
              let latestSession = null;

              for (const resolved of newMsgs) {
                const isJoinMessage = resolved.text === "👋 joined";
                
                const newMsg: ChatMessage = {
                  id: `peer_${resolved.timestamp}`,
                  text: resolved.text,
                  sender: isJoinMessage ? "system" : "peer",
                  timestamp: resolved.timestamp,
                  nick: resolved.nick,
                  meta: {
                    dhtKey: peerPubKeyZ32Ref.current,
                    encryptedPayloadLength: batch.encryptedPayloadLength,
                    dnsRecords: batch.rawRecordNames,
                    packetTimestamp: batch.packetTimestamp,
                  },
                  ...(isJoinMessage && {
                    systemEvent: {
                      type: "join" as const,
                      pubKey: peerPubKeyZ32Ref.current,
                    },
                  }),
                };
                latestSession = addMessage(sessionIdRef.current, newMsg);
              }

              if (latestSession) {
                setMessages([...latestSession.messages]);
              }

              lastActivityRef.current = Date.now();
              receivedNew = true;
            }

            if (batch.callSignal !== null && batch.callSignal !== undefined) {
              try {
                const sig = JSON.parse(batch.callSignal);
                console.log("[chat] received callSignal from peer", peerPubKeyZ32Ref.current.slice(0, 8), "- type:", sig.t, "ts:", sig.ts);
              } catch {
                console.log("[chat] received callSignal (unparseable):", batch.callSignal.slice(0, 50));
              }
              setIncomingCallSignal(batch.callSignal);
            }
          }

          if (receivedNew) {
            await doPublish();
          }

          setStatus("online");
          setLastSync(Date.now());
        } catch (err) {
          console.error(`[chat] poll #${n} error:`, err);
          setStatus("error");
        } finally {
          isPollingRef.current = false;
          if (
            !burnedRef.current &&
            effectIdRef.current === currentEffectId
          ) {
            const idle =
              Date.now() - lastActivityRef.current > IDLE_THRESHOLD;
            const interval = fastPollRef.current
              ? POLL_INTERVAL_FAST
              : idle
                ? POLL_INTERVAL_IDLE
                : POLL_INTERVAL_ACTIVE;
            pollTimerRef.current = setTimeout(poll, interval);
          }
        }
      };

      pollFnRef.current = poll;
      poll();

      const republish = async () => {
        if (burnedRef.current || effectIdRef.current !== currentEffectId)
          return;
        if (sentBufferRef.current.length === 0 && myAckRef.current === 0)
          return;
        await doPublish();
        if (
          !burnedRef.current &&
          effectIdRef.current === currentEffectId
        ) {
          republishTimerRef.current = setTimeout(
            republish,
            REPUBLISH_INTERVAL,
          );
        }
      };
      republishTimerRef.current = setTimeout(republish, REPUBLISH_INTERVAL);
    };

    init();

    return () => {
      cancelled = true;
      pollFnRef.current = null;
      isPollingRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (republishTimerRef.current) {
        clearTimeout(republishTimerRef.current);
        republishTimerRef.current = null;
      }
    };
  }, [params?.seedB64, params?.peerPubKeyB64, params?.encKeyB64]);

  const sendMessage = useCallback(
    async (text: string): Promise<string | null> => {
      if (burnedRef.current) return "Chat has been burned";
      if (!text.trim()) return null;

      const trimmed = text.trim();
      const byteLen = new TextEncoder().encode(trimmed).length;
      if (byteLen > MAX_DHT_TEXT_BYTES) {
        return `Message too large for DHT (${byteLen} bytes, max ${MAX_DHT_TEXT_BYTES}). Try a shorter message or share a link instead.`;
      }

      setIsSending(true);
      lastActivityRef.current = Date.now();

      const timestamp = Date.now();

      const newMsg: ChatMessage = {
        id: `me_${timestamp}`,
        text: trimmed,
        sender: "me",
        timestamp,
        nick: nickRef.current,
        meta: {
          dhtKey: myPubKeyRef.current,
          encryptedPayloadLength: 0,
          dnsRecords: [
            "_msgs",
            "_ts",
            "_ack",
            ...(nickRef.current ? ["_nick"] : []),
            ...(callSignalOutRef.current ? ["_call"] : []),
          ],
          packetTimestamp: timestamp,
        },
      };

      const updated = addMessage(sessionIdRef.current, newMsg);
      if (updated) {
        setMessages([...updated.messages]);
      }

      sentBufferRef.current = [
        ...sentBufferRef.current,
        { t: timestamp, m: trimmed },
      ];

      try {
        const kept = await publishMessages(
          seedB64Ref.current,
          sentBufferRef.current,
          encKeyB64Ref.current,
          myAckRef.current,
          nickRef.current,
        );

        console.log(
          `[chat] sent "${trimmed.slice(0, 40)}…", kept=${kept}/${sentBufferRef.current.length}`,
        );

        if (kept === 0) {
          return "Message could not be published — DHT payload limit exceeded.";
        }
      } catch (err) {
        console.error("Failed to publish message:", err);
        setStatus("error");
        return "Failed to send message. Check your connection.";
      } finally {
        setIsSending(false);
      }

      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (pollFnRef.current) {
        pollFnRef.current();
      }

      return null;
    },
    [],
  );

  const burn = useCallback(() => {
    burnedRef.current = true;
    setIsBurned(true);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (republishTimerRef.current) {
      clearTimeout(republishTimerRef.current);
      republishTimerRef.current = null;
    }
    setStatus("offline");
  }, []);

  const setNick = useCallback((nick: string) => {
    nickRef.current = nick || undefined;
  }, []);

  const setCallSignal = useCallback(async (signal: string | null) => {
    console.log("[chat] setCallSignal called:", signal ? `${signal.slice(0, 50)}...` : null);
    callSignalOutRef.current = signal;
    lastActivityRef.current = Date.now();
    if (doPublishRef.current) {
      try {
        console.log("[chat] calling doPublish with call signal");
        await doPublishRef.current();
        console.log("[chat] doPublish completed");
      } catch (err) {
        console.error("[chat] call signal publish error:", err);
      }
    } else {
      console.warn("[chat] doPublishRef.current is null!");
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollFnRef.current) {
      pollFnRef.current();
    }
  }, []);

  const setChatFastPoll = useCallback((fast: boolean) => {
    fastPollRef.current = fast;
    if (fast && pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
      if (pollFnRef.current) pollFnRef.current();
    }
  }, []);

  const forceRefresh = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollFnRef.current) {
      pollFnRef.current();
    }
  }, []);

  const addSystemMessage = useCallback((msg: ChatMessage) => {
    const updated = addMessage(sessionIdRef.current, msg);
    if (updated) {
      setMessages([...updated.messages]);
    }
  }, []);

  const techInfo: ChatTechInfo = {
    sessionId: sessionIdRef.current,
    myPubKey: myPubKeyRef.current,
    peerPubKey: peerPubKeyZ32Ref.current,
    encKeyPreview: params
      ? params.encKeyB64.slice(0, 8) + "..." + params.encKeyB64.slice(-4)
      : "",
    pollCount: pollCountRef.current,
    currentPollInterval:
      Date.now() - lastActivityRef.current > IDLE_THRESHOLD
        ? POLL_INTERVAL_IDLE
        : POLL_INTERVAL_ACTIVE,
    republishInterval: REPUBLISH_INTERVAL,
    messageTtl: MESSAGE_TTL,
    protocol: "Mainline DHT (BEP44) — Direct UDP",
    encryption: "NaCl secretbox (XSalsa20-Poly1305)",
    relays: [],
    createdAt: sessionCreatedAtRef.current,
    myAck: myAckRef.current,
    peerAck,
    sentBufferSize: sentBufferRef.current.length,
  };

  return {
    messages,
    status,
    lastSync,
    isSending,
    sendMessage,
    burn,
    setNick,
    isBurned,
    techInfo,
    peerAck,
    forceRefresh,
    incomingCallSignal,
    setCallSignal,
    setChatFastPoll,
    addSystemMessage,
  };
}
