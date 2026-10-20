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

/** How often a chat is read whole for the quotes of removed messages (`QuoteSweeps`). */
export const QUOTE_SWEEP_MS = 10_000;

/** Removed messages whose quotes go, by their id here: the reference a reply names each by (`replyRef`), if any. */
export type RemovedQuotes = ReadonlyMap<string, string | undefined>;

/**
 * The quotes of removed messages, here or not (never came, or deleted here first). The replies that quote one are found
 * by reading the chat whole, and a contact or a member can send and remove, or remove ids that never were, at its edit
 * pace. So a chat is read for them at most once a `QUOTE_SWEEP_MS`: the first at once, the ones that come meanwhile
 * together when the time is up.
 */
export class QuoteSweeps {
  private readonly chats = new Map<string, { due: Map<string, string | undefined>; at: number; busy: boolean; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly sweep: (chat: string, removed: RemovedQuotes) => Promise<void>, private readonly now: () => number = Date.now) {}

  add(chat: string, id: string, ref: string | undefined): void {
    let state = this.chats.get(chat);
    if (!state) this.chats.set(chat, state = { due: new Map(), at: -Infinity, busy: false });
    state.due.set(id, ref);
    this.next(chat);
  }

  /** The chat is gone: what waits for it is dropped. */
  forget(chat: string): void {
    clearTimeout(this.chats.get(chat)?.timer);
    this.chats.delete(chat);
  }

  stop(): void {
    for (const state of this.chats.values()) clearTimeout(state.timer);
    this.chats.clear();
  }

  private next(chat: string): void {
    const state = this.chats.get(chat);
    if (!state?.due.size || state.busy || state.timer) return;
    const wait = state.at + QUOTE_SWEEP_MS - this.now();
    if (wait > 0) { state.timer = setTimeout(() => { state.timer = undefined; this.next(chat); }, wait); return; }
    const removed = state.due;
    state.due = new Map();
    state.busy = true;
    state.at = this.now();
    void this.sweep(chat, removed).catch(() => {}).finally(() => {
      state.busy = false;
      if (this.chats.get(chat) === state) this.next(chat);
    });
  }
}

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
