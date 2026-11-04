import { STORES, store, wrap } from "../shared/idb";
import type { SavedMessage, StoredMessage } from "../shared/types";

/**
 * Saved messages: marks the person puts on messages of any chat or group to find them again in one list. Kept for this
 * profile on this device only, in one settings record; nothing goes on the wire, so contacts and older apps never see
 * them. A mark names a row (`linkId`: a chat's link or `group:<id>`, `id`: the row here) and is read with the row, so an
 * edit shows its latest version and a deleted message, chat or group drops out of the list.
 */
export const SAVED_MESSAGES_KEY = "savedMessages";

/** One saved message: where its row is and when it was saved. */
export interface SavedMark { linkId: string; id: string; savedAt: number }

/** The settings record (`SAVED_MESSAGES_KEY`): the marks, oldest first. */
export interface SavedMarks { at: number; items: SavedMark[] }

const isMark = (m: unknown): m is SavedMark => {
  const v = m as Partial<SavedMark> | null;
  return !!v && typeof v === "object" && typeof v.linkId === "string" && typeof v.id === "string" && Number.isSafeInteger(v.savedAt);
};

/** The marks a record holds; anything else reads as none (a record a newer version wrote keeps its readable marks). */
export function readSavedMarks(value: unknown): SavedMark[] {
  const items = (value as Partial<SavedMarks> | null)?.items;
  return Array.isArray(items) ? items.filter(isMark) : [];
}

const sameRow = (a: { linkId: string; id: string }, b: { linkId: string; id: string }) => a.linkId === b.linkId && a.id === b.id;

/** This profile's saved marks on this device, in one place: every change goes through one queue, so none is lost. */
export class SavedMessages {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly changed: () => void) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async marks(): Promise<SavedMark[]> {
    return readSavedMarks(await wrap((await store(STORES.settings, "readonly")).get(SAVED_MESSAGES_KEY)));
  }

  private async write(items: SavedMark[]): Promise<void> {
    await wrap((await store(STORES.settings, "readwrite")).put({ at: Date.now(), items } satisfies SavedMarks, SAVED_MESSAGES_KEY));
  }

  /** The row `messageId` names in the chat: its id here or, in a 1:1 chat, the id both sides know it by. */
  private async row(linkId: string, messageId: string): Promise<StoredMessage | undefined> {
    const messages = await store(STORES.messages, "readonly");
    const ids = linkId.startsWith("group:") ? [messageId] : [messageId, `peer_${messageId}`, `me_${messageId}`];
    for (const id of ids) {
      const row = await wrap<StoredMessage | undefined>(messages.get([linkId, id]));
      if (row) return row;
    }
    return undefined;
  }

  /**
   * Saves a message, or unsaves it with `remove`. Saving one already saved keeps its first time. `removed`: whether a
   * mark went. An id that names neither a mark nor a message of the chat (a typo) is "not in this chat", as `save` says
   * it; before, it answered done and the message meant stayed saved (agents#1580).
   */
  save({ linkId, messageId, remove }: { linkId: string; messageId: string; remove?: boolean }): Promise<{ error: string | null; removed?: boolean }> {
    return this.serial(async () => {
      if (typeof linkId !== "string" || !linkId) return { error: "No chat named" };
      if (typeof messageId !== "string" || !messageId) return { error: "No message named" };
      const marks = await this.marks();
      if (remove) {
        // A mark goes even when its row is gone: by the id it was saved with, or by the row the id names now.
        const row = await this.row(linkId, messageId);
        const next = marks.filter(m => !sameRow(m, { linkId, id: messageId }) && !(row && sameRow(m, row)));
        if (next.length !== marks.length) { await this.write(next); this.changed(); return { error: null, removed: true }; }
        // Not saved, and there: unsaving it again is nothing to say. Not saved, and not there either: not this chat's.
        return row ? { error: null, removed: false } : { error: "That message is not in this chat" };
      }
      const row = await this.row(linkId, messageId);
      if (!row) return { error: "That message is not in this chat" };
      if (marks.some(m => sameRow(m, row))) return { error: null };
      await this.write([...marks, { linkId, id: row.id, savedAt: Date.now() }]);
      this.changed();
      return { error: null };
    });
  }

  /**
   * The saved messages, the last saved first, each with its row as it is now. A mark whose row is gone (deleted here or
   * for everyone, or its chat or group deleted) is dropped from the record.
   */
  list(): Promise<SavedMessage[]> {
    return this.serial(async () => {
      const marks = await this.marks();
      if (!marks.length) return [];
      const messages = await store(STORES.messages, "readonly");
      const rows = await Promise.all(marks.map(m => wrap<StoredMessage | undefined>(messages.get([m.linkId, m.id]))));
      const kept = marks.filter((_, i) => rows[i]);
      if (kept.length !== marks.length) await this.write(kept);
      return marks.flatMap((m, i) => rows[i] ? [{ savedAt: m.savedAt, message: rows[i]! }] : []).reverse();
    });
  }
}
