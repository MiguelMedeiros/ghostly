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
}

export class EditQueue {
  private readonly pace: RateWindow;
  private readonly policy: ResendPolicy;
  private readonly now: () => number;
  /** Per message: the edit number last sent, when, and how many times that number went. */
  private sent = new Map<string, { seq: number; at: number; attempts: number; receiptMs: number }>();
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
    if (reopened) this.sent.clear();
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do { this.again = false; await this.run(); } while (this.again && !this.stopped);
      } finally { this.flushing = null; }
    })();
    return this.flushing;
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
    const due = (await this.deps.read())
      .filter(m => m.sender === "me" && m.edit?.pending && m.wireId)
      .sort((a, b) => said(a) - said(b) || a.edit!.at - b.edit!.at);
    let next = Infinity;
    for (const message of due) {
      const edit = message.edit!;
      // Past the resend window: given up on, as an unconfirmed message is.
      if (now - edit.at >= this.policy.windowMs) { this.sent.delete(message.id); await this.deps.settle(message.id, edit.seq); continue; }
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
      const pace = this.pace.wait();
      if (pace > 0) { next = Math.min(next, now + pace); break; }
      if (!this.pace.take()) break;
      const receiptMs = typeof this.deps.receiptMs === "function" ? this.deps.receiptMs() : this.deps.receiptMs ?? 20_000;
      const error = await this.deps.send({ id: message.wireId!, e: edit.seq, ts: edit.at, m: message.text, ...(message.preview && { pv: message.preview }), ...(message.card && { sc: message.card }) }, message);
      // This one cannot go now (too long for the DHT, its message not confirmed yet): the others still may.
      if (error) continue;
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
