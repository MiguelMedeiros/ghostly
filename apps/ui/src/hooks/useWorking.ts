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
  return useMemo(() => {
    const byChat = workingByChat(index);
    const byPeer = new Map<string, WorkingEntry>();
    if (!byChat.size) return byPeer;
    for (const link of state?.links ?? []) {
      const entry = byChat.get(link.id);
      if (entry && link.peerPubKeyZ32) byPeer.set(link.peerPubKeyZ32, entry);
    }
    return byPeer;
  }, [index, state?.links]);
}
