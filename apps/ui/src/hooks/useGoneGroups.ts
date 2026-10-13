import { useEffect } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { forgetGroupLocal } from "../lib/groups";
import { activeProfileId, chosenProfileId } from "../lib/profiles";
import { getPrefix } from "../lib/storage";

/**
 * How long a group stays missing from the list before it counts as gone. The engine may drop a row for a moment while
 * it replaces it (a group I was removed from, invited again, goes back as an invitation after its edges close).
 */
export const GONE_AFTER_MS = 3000;

/** The groups the peer lists now, when it has loaded them and runs this page's profile; else null. */
function listed(): Set<string> | null {
  const state = engine.state;
  // Starting (here, or the extension's document started again), the peer lists none yet. Another page's switch
  // restarts the extension's peer on the other profile, whose groups this page's profile never had.
  if (!state?.groupsLoaded || chosenProfileId() !== activeProfileId()) return null;
  return new Set(state.groups.map(group => group.id));
}

/**
 * A group that goes from the engine's list without a press in its page takes what this device keeps beside it too
 * (`forgetGroupLocal`): an invitation declined from its row, one taken back that expired, a group the engine forgets
 * by itself. A group that stays (removed, invited again and declined: its history is kept) keeps its draft and folder.
 */
export function useGoneGroups(): void {
  useEffect(() => {
    let seen: { prefix: string; ids: Set<string> } | null = null;
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    const settle = (id: string, prefix: string) => {
      waiting.delete(id);
      const now = listed();
      if (now && !now.has(id) && getPrefix() === prefix) forgetGroupLocal(id);
    };
    const check = () => {
      const ids = listed(), prefix = getPrefix();
      if (!ids) { seen = null; return; }
      for (const [id, timer] of waiting) if (ids.has(id)) { clearTimeout(timer); waiting.delete(id); }
      if (seen?.prefix === prefix) {
        for (const id of seen.ids) if (!ids.has(id) && !waiting.has(id)) waiting.set(id, setTimeout(() => settle(id, prefix), GONE_AFTER_MS));
      }
      seen = { prefix, ids };
    };
    check();
    const stop = engine.subscribe(check);
    return () => { stop(); for (const timer of waiting.values()) clearTimeout(timer); };
  }, []);
}
