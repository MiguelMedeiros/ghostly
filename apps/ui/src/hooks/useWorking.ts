import { useMemo } from "react";
import { useEngineState } from "../lib/identities";
import { workingByChat, type WorkingEntry } from "../lib/working";
import { useCardIndex } from "./useTaskBoard";

/*
 * Each contact's running tasks (WISP 405 § Showing a card), by the contact's key: what the mark on their chat's row
 * says. Read from the engine's card index (`useCardIndex`), as the usage meter is: no chat's history is read for it.
 */

/** The running tasks of each 1:1 chat, by the contact's key; empty while no contact has one. */
export function useWorkingByPeer(): ReadonlyMap<string, WorkingEntry> {
  const index = useCardIndex();
  const state = useEngineState();
  // From the index alone: every engine state brings the chats as a new list, and the index holds every card there is.
  const byChat = useMemo(() => workingByChat(index), [index]);
  return useMemo(() => {
    const byPeer = new Map<string, WorkingEntry>();
    if (!byChat.size) return byPeer;
    for (const link of state?.links ?? []) {
      const entry = byChat.get(link.id);
      if (entry && link.peerPubKeyZ32) byPeer.set(link.peerPubKeyZ32, entry);
    }
    return byPeer;
  }, [byChat, state?.links]);
}

/** One contact's running tasks, or none. */
export function useWorkingOf(peerKey: string | undefined): WorkingEntry | undefined {
  const byPeer = useWorkingByPeer();
  return peerKey ? byPeer.get(peerKey) : undefined;
}
