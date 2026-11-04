import { useMemo } from "react";
import { chatKeys, useEngineValue } from "../lib/engineState";
import { usageByChat, type UsageEntry } from "../lib/usage";
import { useCardIndex } from "./useTaskBoard";

/*
 * Each contact's usage card (WISP 405 § Usage), by the contact's key: what their chat's row and header show. Read from
 * the engine's card index (`useCardIndex`), which follows every chat's cards without reading a chat's history.
 */

/** The usage card that stands for each 1:1 chat, by the contact's key; empty while the profile has none. */
export function useUsageByPeer(): ReadonlyMap<string, UsageEntry> {
  const index = useCardIndex();
  // Each chat's id and contact key, and nothing else of the engine's state: every engine state brings the chats as a new
  // list, which drew every chat using this (an open one, and each kept loaded off screen) on every state.
  const keys = useEngineValue(chatKeys);
  // From the index alone: the index holds every card there is.
  const byChat = useMemo(() => usageByChat(index), [index]);
  return useMemo(() => {
    const byPeer = new Map<string, UsageEntry>();
    if (!byChat.size) return byPeer;
    for (const [id, peerKey] of keys) {
      const entry = byChat.get(id);
      if (entry && peerKey) byPeer.set(peerKey, entry);
    }
    return byPeer;
  }, [byChat, keys]);
}

/** One contact's usage card, or none. */
export function useUsageOf(peerKey: string | undefined): UsageEntry | undefined {
  const byPeer = useUsageByPeer();
  return peerKey ? byPeer.get(peerKey) : undefined;
}
