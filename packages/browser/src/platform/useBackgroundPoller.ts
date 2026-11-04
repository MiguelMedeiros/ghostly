import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Desktop from "../../../../apps/ui/src/hooks/useBackgroundPoller";
import { sessionIdForPeer } from "../../../../apps/ui/src/lib/storage";
import { engine } from "./engine";
import { startSessionSync } from "./sync";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const hasState = () => !!engine.state;

/** The chats mid-sync, but the open one, one id a line: a string, so a state with the same ones draws nothing. */
function syncingIds(activeSessionId: string | null): string {
  const ids: string[] = [];
  for (const link of engine.state?.links ?? []) {
    if (!link.poll.polling || link.lastSyncAt > 0) continue;
    // By the chats' keys alone: on every state at a start, while each link makes its first read.
    const id = sessionIdForPeer(link.peerPubKeyZ32);
    if (id && id !== activeSessionId) ids.push(id);
  }
  return ids.join("\n");
}

/**
 * Stands in for Desktop's background poller. Nothing is polled from the page:
 * the peer does that for every link, all the time, and `sync.ts` files what
 * it receives. This only reports which chats are mid-sync.
 *
 * Only that is read of the engine's state: it sends its whole state anew on every change (up to 20 a second while a
 * file moves), and the whole of it drew the chat list, always on screen, on each.
 */
export const useBackgroundPoller: typeof Desktop.useBackgroundPoller = (activeSessionId) => {
  const ready = useSyncExternalStore(subscribe, hasState);
  const syncing = useSyncExternalStore(subscribe, () => syncingIds(activeSessionId));
  const [initialSyncComplete, setInitialSyncComplete] = useState(false);

  useEffect(() => startSessionSync(), []);
  useEffect(() => {
    if (ready && !initialSyncComplete) setInitialSyncComplete(true);
  }, [ready, initialSyncComplete]);

  const syncingSessions = useMemo(() => new Set(syncing ? syncing.split("\n") : []), [syncing]);
  return { syncingSessions, initialSyncComplete };
};
