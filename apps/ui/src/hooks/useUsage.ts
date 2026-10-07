import { useMemo } from "react";
import { useEngineState } from "../lib/identities";
import { usageByChat, type UsageEntry } from "../lib/usage";
import { useCardIndex } from "./useTaskBoard";

/*
 * Each contact's usage card (WISP 405 § Usage), by the contact's key: what their chat's row and header show. Read from
 * the engine's card index (`useCardIndex`), which follows every chat's cards without reading a chat's history.
 */

/** The usage card that stands for each 1:1 chat, by the contact's key; empty while the profile has none. */
export function useUsageByPeer(): ReadonlyMap<string, UsageEntry> {
  const index = useCardIndex();
  const state = useEngineState();
  return useMemo(() => {
    const byChat = usageByChat(index);
    const byPeer = new Map<string, UsageEntry>();
    if (!byChat.size) return byPeer;
    for (const link of state?.links ?? []) {
      const entry = byChat.get(link.id);
      if (entry && link.peerPubKeyZ32) byPeer.set(link.peerPubKeyZ32, entry);
    }
    return byPeer;
  }, [index, state?.links]);
}

/** One contact's usage card, or none. */
export function useUsageOf(peerKey: string | undefined): UsageEntry | undefined {
  const byPeer = useUsageByPeer();
  return peerKey ? byPeer.get(peerKey) : undefined;
}
