import { useEffect, useRef, useState } from "react";
import { listSessions, addMessage } from "../lib/storage";
import { resolveMessages } from "../lib/pkarr";
import type { ChatMessage } from "../lib/types";

const BG_POLL_INTERVAL = 20_000;

export interface BackgroundPollerState {
  syncingSessions: Set<string>;
  initialSyncComplete: boolean;
}

export function useBackgroundPoller(
  activeSessionId: string | null,
): BackgroundPollerState {
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  const [syncingSessions, setSyncingSessions] = useState<Set<string>>(
    new Set(),
  );
  const [initialSyncComplete, setInitialSyncComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let isFirstRound = true;

    const lastSeenMap: Record<string, number> = {};

    const sessions = listSessions();
    for (const s of sessions) {
      const maxPeerTs = s.messages.reduce(
        (max, m) => (m.sender === "peer" ? Math.max(max, m.timestamp) : max),
        0,
      );
      lastSeenMap[s.id] = maxPeerTs;
    }

    const pollAll = async () => {
      if (cancelled) return;

      const sessions = listSessions();

      const toSync = sessions
        .filter((s) => s.id !== activeIdRef.current)
        .map((s) => s.id);
      if (toSync.length > 0) {
        setSyncingSessions(new Set(toSync));
      }

      for (const session of sessions) {
        if (cancelled) break;
        if (session.id === activeIdRef.current) continue;

        try {
          const batch = await resolveMessages(
            session.peerPubKeyB64,
            session.encKeyB64,
          );

          if (cancelled) break;

          setSyncingSessions((prev) => {
            const next = new Set(prev);
            next.delete(session.id);
            return next;
          });

          if (!batch) continue;

          const lastSeen = lastSeenMap[session.id] ?? 0;

          if (batch.latestTimestamp > 0 && batch.latestTimestamp > lastSeen) {
            const newMsgs = batch.messages.filter(
              (m) => m.timestamp > lastSeen,
            );

            for (const resolved of newMsgs) {
              const newMsg: ChatMessage = {
                id: `peer_${resolved.timestamp}`,
                text: resolved.text,
                sender: "peer",
                timestamp: resolved.timestamp,
                nick: resolved.nick,
                meta: {
                  dhtKey: session.peerPubKeyB64,
                  encryptedPayloadLength: batch.encryptedPayloadLength,
                  dnsRecords: batch.rawRecordNames,
                  packetTimestamp: batch.packetTimestamp,
                },
              };
              addMessage(session.id, newMsg);
            }

            lastSeenMap[session.id] = batch.latestTimestamp;
          }
        } catch (err) {
          setSyncingSessions((prev) => {
            const next = new Set(prev);
            next.delete(session.id);
            return next;
          });
          console.error(
            `[bg-poll] error polling session ${session.id}:`,
            err,
          );
        }
      }

      if (isFirstRound) {
        isFirstRound = false;
        setInitialSyncComplete(true);
      }

      if (!cancelled) {
        timer = setTimeout(pollAll, BG_POLL_INTERVAL);
      }
    };

    timer = setTimeout(pollAll, 1_500);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { syncingSessions, initialSyncComplete };
}
