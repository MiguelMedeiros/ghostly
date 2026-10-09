import { EDIT_BUFFER_MAX, EDIT_BUFFER_MS, EDIT_RATE_WINDOW_MS, EDIT_SEND_LIMIT, RateWindow, dhtEditId, type WireEdit } from "@ghostly/core";
import type { StoredMessage } from "../shared/types";
import { RESEND_POLICY, type ResendPolicy } from "./outbox";

/**
 * My edits on their way to the contact (WISP 400 § Edits), one chat's worth. What goes is always the latest version of
 * a message, read from its row: an edit made while an earlier one waits replaces it, so a bot rewriting a status never
 * queues old versions. It keeps the outbox's resend policy (the window, the attempts, the backoff) in a queue of its
 * own, since the outbox sends rows and an edited row was delivered long ago.
 *
 * An edit goes on a live session where both sides offer edit/1, or on the DHT floor to a contact whose app takes edits
 * there, at most `EDIT_SEND_LIMIT` per window; the rest wait for the window, a confirmation, or the next session. A
 * message that never left yet (`waiting`) carries its latest text when it goes, and its edit follows it.
 */
/**
 * A card that goes again live (`restore`, WISP 405 § Cards that went as text) goes at most once per this long: one a
 * reconnect owes many go in a trickle, not a burst. Two edit slots of the pace (10 in 10 s), so cards going again
 * take at most half of it and the author's live updates keep the rest; the CLI paces a card's own updates alike (2.5 s).
 */
export const CARD_RESTORE_GAP_MS = 2 * EDIT_RATE_WINDOW_MS / EDIT_SEND_LIMIT;

/** What makes a card the same card across messages: a new message may reuse a card's id, and the newest stands for it. */
const cardKey = (message: StoredMessage) => message.card && `${message.card.kind}\n${message.card.id}`;

export interface EditQueueDeps {
  read(): Promise<StoredMessage[]>;
  /** Says one edit of this message: an error when it could not go now (it is tried again later). */
  send(edit: WireEdit, message: StoredMessage): string | null | Promise<string | null>;
  /** The chat can carry edits now: live with edit/1 on both sides, or the DHT floor to a contact that takes them. */
  ready(): boolean;
  /** The contact confirmed the edit shown (or one after it), or it is given up on: the row is no longer pending. */
  settle(messageId: string, seq: number): Promise<void>;
  now?: () => number;
  policy?: Partial<ResendPolicy>;
  /** How long an edit sent now waits for its confirmation before it may go again (the DHT floor takes minutes). */
  receiptMs?: number | (() => number);
  restoreGapMs?: number;
}

export class EditQueue {
  private readonly pace: RateWindow;
  private readonly policy: ResendPolicy;
  private readonly now: () => number;
  /** Per message: the edit number last sent, when, and how many times that number went. */
  private sent = new Map<string, { seq: number; at: number; attempts: number; receiptMs: number }>();
  /** When a card that goes again last went (`CARD_RESTORE_GAP_MS`). */
  private restoredAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: EditQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.policy = { ...RESEND_POLICY, ...deps.policy };
    this.pace = new RateWindow(EDIT_SEND_LIMIT, EDIT_RATE_WINDOW_MS, this.now);
  }

  /**
   * Sends what waits, oldest edit first. `reopened`: a new session, so what the last one sent without a confirmation
   * goes again at once, with a fresh count of attempts.
   */
  flush({ reopened = false }: { reopened?: boolean } = {}): Promise<void> {
    if (reopened) this.reopened();
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do { this.again = false; await this.run(); } while (this.again && !this.stopped);
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  /**
   * A new session: what the last one sent without a confirmation may go again at once, with a fresh count of attempts.
   * Said once, as the session opens and before anything goes on it: said again later, it would send a second time what
   * this session already sent (two flushes of one opening, each starting over, sent a restored question's edit twice).
   */
  reopened(): void {
    this.sent.clear();
  }

  /** The contact confirmed edit `seq` of my message with this wire id. */
  async received(wireId: string, seq: number): Promise<void> {
    const row = (await this.deps.read()).find(m => m.sender === "me" && m.wireId === wireId);
    if (!row?.edit?.pending || row.edit.seq > seq) return;
    this.sent.delete(row.id);
    await this.deps.settle(row.id, row.edit.seq);
  }

  /** The contact confirmed, on the DHT floor, the edit that went there under this id (`dhtEditId`). */
  async receivedOnDht(id: string): Promise<void> {
    const row = (await this.deps.read()).find(m => m.sender === "me" && m.edit?.pending && m.wireId && dhtEditId(m.wireId, m.edit.seq) === id);
    if (!row) return;
    this.sent.delete(row.id);
    await this.deps.settle(row.id, row.edit!.seq);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    // Edits not said yet first, oldest first; then those said without a confirmation: a resend never holds a new edit back.
    const said = (m: StoredMessage) => this.sent.get(m.id)?.seq === m.edit!.seq ? 1 : 0;
    const rows = await this.deps.read();
    // The newest message of mine of each card: a card going again from an older one would show an older version.
    const newest = new Map<string, number>();
    for (const m of rows) { const key = m.sender === "me" && cardKey(m); if (key && m.timestamp > (newest.get(key) ?? -Infinity)) newest.set(key, m.timestamp); }
    const due = rows
      .filter(m => m.sender === "me" && m.edit?.pending && m.wireId)
      .sort((a, b) => said(a) - said(b) || a.edit!.at - b.edit!.at);
    const gap = this.deps.restoreGapMs ?? CARD_RESTORE_GAP_MS;
    let next = Infinity;
    for (const message of due) {
      const edit = message.edit!;
      // Past the resend window: given up on, as an unconfirmed message is.
      if (now - edit.at >= this.policy.windowMs) { this.sent.delete(message.id); await this.deps.settle(message.id, edit.seq); continue; }
      // A card going again that a newer message of the same card stands for now: dropped, not sent.
      if (edit.restore && message.timestamp < (newest.get(cardKey(message) || "") ?? -Infinity)) { this.sent.delete(message.id); await this.deps.settle(message.id, edit.seq); continue; }
      // Never sent yet: it goes with its latest text, and its edit after it.
      if (message.delivery === "waiting") continue;
      if (!this.deps.ready()) return;
      const last = this.sent.get(message.id);
      if (last?.seq === edit.seq) {
        if (last.attempts >= this.policy.maxAttempts) continue;
        const wait = this.policy.backoffMs[Math.min(last.attempts - 1, this.policy.backoffMs.length - 1)];
        const at = last.at + Math.max(wait, last.receiptMs);
        if (at > now) { next = Math.min(next, at); continue; }
      }
      // Cards going again go one per gap; a live edit after them is not held back.
      if (edit.restore && this.restoredAt + gap > now) { next = Math.min(next, this.restoredAt + gap); continue; }
      const pace = this.pace.wait();
      if (pace > 0) { next = Math.min(next, now + pace); break; }
      if (!this.pace.take()) break;
      const receiptMs = typeof this.deps.receiptMs === "function" ? this.deps.receiptMs() : this.deps.receiptMs ?? 20_000;
      const error = await this.deps.send({ id: message.wireId!, e: edit.seq, ts: edit.at, m: message.text, ...(message.preview && { pv: message.preview }), ...(message.card && { sc: message.card }) }, message);
      // This one cannot go now (too long for the DHT, its message not confirmed yet): the others still may.
      if (error) continue;
      if (edit.restore) this.restoredAt = now;
      this.sent.set(message.id, { seq: edit.seq, at: now, attempts: (last?.seq === edit.seq ? last.attempts : 0) + 1, receiptMs });
      next = Math.min(next, now + receiptMs);
    }
    this.schedule(next);
  }

  private schedule(at: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !Number.isFinite(at)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, Math.max(0, at - this.now()));
  }
}

/** A card's updates from someone else are applied (stored, shown) at most once per this long, per message. */
export const CARD_APPLY_GAP_MS = 1_000;

/**
 * Received status card updates, paced per message (WISP 405 · Status Cards): the first applies at once, the rest within
 * `CARD_APPLY_GAP_MS` wait, and only the highest edit number of them applies when the time is up. A sender that
 * ignores its own pace costs this side one write and one render a second per card, whatever it sends.
 */
export class CardEditPacer {
  private readonly slots = new Map<string, { last: number; e?: number; apply?: () => Promise<void>; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly now: () => number = Date.now, private readonly gapMs = CARD_APPLY_GAP_MS) {}

  /** Applies edit `e` of the message under `key` now, or later with whatever higher edit comes meanwhile. */
  async take(key: string, e: number, apply: () => Promise<void>): Promise<void> {
    const slot = this.slots.get(key) ?? { last: 0 };
    this.slots.set(key, slot);
    const due = slot.last + this.gapMs - this.now();
    if (due <= 0 && !slot.timer) { slot.last = this.now(); await apply(); return; }
    if (slot.e !== undefined && slot.e >= e) return;
    slot.e = e; slot.apply = apply;
    slot.timer ??= setTimeout(() => {
      const run = slot.apply;
      slot.timer = undefined; slot.apply = undefined; slot.e = undefined; slot.last = this.now();
      void run?.().catch(() => {});
    }, Math.max(0, due));
    // Kept small: a slot whose card went quiet is forgotten.
    if (this.slots.size > 512) for (const [k, s] of this.slots) { if (!s.timer) { this.slots.delete(k); break; } }
  }

  stop(): void {
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots.clear();
  }
}

/**
 * The contact's edits of messages not here yet (an edit that overtook its message on another path), per chat: kept
 * `EDIT_BUFFER_MS` at most, the highest number per message, `EDIT_BUFFER_MAX` messages at most.
 */
export class EditBuffer<T extends { id: string; e: number } = WireEdit> {
  private held = new Map<string, Map<string, { edit: T; until: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  hold(linkId: string, edit: T): void {
    const now = this.now();
    const chat = this.held.get(linkId) ?? new Map<string, { edit: T; until: number }>();
    for (const [id, entry] of chat) if (entry.until <= now) chat.delete(id);
    const known = chat.get(edit.id);
    if (known && known.edit.e >= edit.e) return;
    if (!known && chat.size >= EDIT_BUFFER_MAX) chat.delete(chat.keys().next().value!);
    chat.set(edit.id, { edit, until: now + EDIT_BUFFER_MS });
    this.held.set(linkId, chat);
  }

  /** The edit held for this message, if it is still fresh; it is no longer held. */
  take(linkId: string, wireId: string): T | undefined {
    const chat = this.held.get(linkId), entry = chat?.get(wireId);
    if (!chat || !entry) return undefined;
    chat.delete(wireId);
    if (!chat.size) this.held.delete(linkId);
    return entry.until > this.now() ? entry.edit : undefined;
  }

  forget(linkId: string): void { this.held.delete(linkId); }
}
