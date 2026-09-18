import { useEffect, useState, useSyncExternalStore } from "react";
import type * as Desktop from "../../../src/hooks/useBackgroundPoller";
import { engine } from "./engine";
import { sessionForPeer, startSessionSync } from "./sync";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const getState = () => engine.state;

/**
 * Stands in for Desktop's background poller. Nothing is polled from the page:
 * the peer does that for every link, all the time, and `sync.ts` files what
 * it receives. This only reports which chats are mid-sync.
 */
export const useBackgroundPoller: typeof Desktop.useBackgroundPoller = (activeSessionId) => {
  const state = useSyncExternalStore(subscribe, getState);
  const [initialSyncComplete, setInitialSyncComplete] = useState(false);

  useEffect(() => startSessionSync(), []);
  useEffect(() => {
    if (state && !initialSyncComplete) setInitialSyncComplete(true);
  }, [state, initialSyncComplete]);

  const syncingSessions = new Set<string>();
  for (const link of state?.links ?? []) {
    if (!link.poll.polling || link.lastSyncAt > 0) continue;
    const session = sessionForPeer(link.peerPubKeyZ32);
    if (session && session.id !== activeSessionId) syncingSessions.add(session.id);
  }
  return { syncingSessions, initialSyncComplete };
};
