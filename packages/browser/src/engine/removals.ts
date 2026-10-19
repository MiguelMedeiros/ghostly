import { MAX_REMOVAL_NUMBER, REMOVED_TEXT } from "@ghostly/core";
import type { StoredMessage } from "../shared/types";

/*
 * My messages I deleted for everyone (WISP 400 § Delete for everyone), on their way. The message goes from this device at
 * once, as a delete here does, and what is left of it is one of these: its id, the number of its removal and when it
 * was made, kept with the chat (a 1:1 chat's link, a group's record) across restarts. The edit queues read each as a row
 * of mine whose edit is pending (`removalRow`), so a removal goes, is said again and handed on exactly as an edit of the
 * message would be, while no page, list, search or Tasks view ever sees a row for it.
 */

/** A removal of mine on its way. */
export interface Removal {
  /** The message's row id here. */
  id: string;
  /** The id the contact knows it by (a 1:1 chat): its wire id, or a file's offer id. A group's message id is its own. */
  wireId?: string;
  /** The removal's edit number: one past the message's last edit. */
  e: number;
  at: number;
  /** Not confirmed (a 1:1 chat) or not said to the group yet. */
  pending?: true;
}

/** Removals a chat keeps: as many as the ids it remembers deleting. */
export const MAX_REMOVALS = 500;

/** The removal of a message after its last edit `seq`: one past it, at most `MAX_REMOVAL_NUMBER`. */
export const removalNumber = (seq: number | undefined) => Math.min((seq ?? 0) + 1, MAX_REMOVAL_NUMBER);

/** The row a removal reads as to the edit queues: mine, its fallback text, its edit pending until said. */
export function removalRow(linkId: string, removal: Removal): StoredMessage {
  return {
    linkId, id: removal.id, ...(removal.wireId && { wireId: removal.wireId }), text: REMOVED_TEXT, sender: "me", timestamp: removal.at,
    via: "datalink", delivery: "delivered", removed: true, edit: { seq: removal.e, at: removal.at, history: [], ...(removal.pending && { pending: true as const }) },
  };
}

/** The list with this removal in it, in place of an older one of the same message; the newest `MAX_REMOVALS`. */
export function withRemoval(list: readonly Removal[] | undefined, removal: Removal): Removal[] {
  return [...(list ?? []).filter(r => r.id !== removal.id), removal].slice(-MAX_REMOVALS);
}

/**
 * A change an edit queue made to a removal's row (`patch`), on the list: the edit said or confirmed is no longer pending.
 * `drop`: confirmed in a 1:1 chat, nothing is left to say. Null when nothing changed.
 */
export function patchRemoval(list: readonly Removal[] | undefined, id: string, change: (row: StoredMessage) => Partial<StoredMessage> | null, linkId: string, drop = false): { list: Removal[]; row: StoredMessage } | null {
  const removal = list?.find(r => r.id === id);
  if (!removal) return null;
  const row = removalRow(linkId, removal), patch = change(row);
  if (!patch) return null;
  const next = { ...row, ...patch };
  const left = list!.filter(r => r.id !== id);
  if (drop && !next.edit?.pending) return { list: left, row: next };
  const { pending: _said, ...said } = removal;
  return { list: [...left, next.edit?.pending ? removal : said], row: next };
}
