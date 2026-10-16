import { useEffect, useState, useSyncExternalStore } from "react";
import type * as Desktop from "../../../../apps/ui/src/hooks/useBackgroundPoller";
import { sessionIdForPeer } from "../../../../apps/ui/src/lib/storage";
import { engine } from "./engine";
import { startSessionSync } from "./sync";

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
    // By the chats' keys alone: on every render at a start, while each link makes its first read.
    const id = sessionIdForPeer(link.peerPubKeyZ32);
    if (id && id !== activeSessionId) syncingSessions.add(id);
  }
  return { syncingSessions, initialSyncComplete };
};
