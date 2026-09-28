import {
  EDIT_RATE_WINDOW_MS, EDIT_RECEIVE_LIMIT, EDIT_SEND_LIMIT, GROUP_EDIT_TEXT_BYTES, MAX_EDITS_PER_MESSAGE, RateWindow, carryMentions, mentionsMember, receivedTimestamp, utf8Encode,
  type GroupEdit, type GroupMention,
} from "@ghostly/core";
import { canEditInGroup, takesPeerEdit, withEdit } from "../shared/edits";
import type { StoredMessage } from "../shared/types";
import { EditBuffer } from "./edits";
import { RESEND_POLICY } from "./outbox";

/*
 * Edits in groups (WISP 9xx § Edits, both profiles), as the engine keeps them: on the message's row, the highest edit
 * number winning, the versions it replaces in its history, as in a 1:1 chat (WISP 400 § Edits). How an edit travels is
 * the group's (`send`): a private group's `group-edit` frames over the edges, a community's application frame.
 *
 * A group has no receipts: my edit is pending only until it was said to the group, at most `EDIT_SEND_LIMIT` per window
 * per group (a bot rewriting a status says only its latest text). A private group's member whose edge was down hears my
 * latest edits again when it opens (`resend`); a community's members catch up from each other.
 */

export interface GroupEditsHost {
  messages(chat: string): Promise<StoredMessage[]>;
  /** One row by its id (`db.getMessage`): an edit names its message so, and a long group is not read whole for it. */
  message?(chat: string, id: string): Promise<StoredMessage | undefined>;
  /** Changes one row in place (`db.patchMessage`); undefined when the row is gone or nothing changed. */
  patch(chat: string, id: string, change: (message: StoredMessage) => Partial<StoredMessage> | null): Promise<StoredMessage | undefined>;
  /** Row `id` of the chat changed: the pages hear it. Never a new message: no sound, no unread, no move in the list. */
  changed(chat: string, id: string): Promise<void> | void;
  /** My key in an active group, who is in it now, whether it is a community, and whether I am its admin. */
  membership(groupId: string): { me: string; members: ReadonlySet<string>; community: boolean; admin?: boolean } | undefined;
  /** Says an edit to the group (a private group's: to member `to` alone, when given). An error when it could not go now. */
  send(groupId: string, edit: GroupEdit, to?: string): Promise<string | null>;
  now?(): number;
}

/** What `edit` answers: `refused` when it is not something to edit (the page says so and keeps the edit open). */
export interface GroupEditResult { error: string | null; refused?: boolean; messageId?: string }

/** A member's latest edits said again on an edge that opens: below what a receiver takes in one window. */
export const GROUP_EDIT_RESEND = 16;
/** An edit that could not go (no epoch key yet) is tried again after this long. */
const RETRY_MS = 10_000;

const chatOf = (groupId: string) => `group:${groupId}`;

export class GroupEdits {
  private readonly now: () => number;
  private readonly buffer: EditBuffer<GroupEdit & { sender: string }>;
  private readonly sendPace = new Map<string, RateWindow>();
  private readonly receivePace = new Map<string, RateWindow>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushing = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly host: GroupEditsHost) {
    this.now = host.now ?? Date.now;
    this.buffer = new EditBuffer(this.now);
  }

  /**
   * Edits a text of mine in a group: the new text here at once, and to the group as soon as the pace allows. Mentions
   * the message had stay where their words still are; `added` are those picked while editing.
   */
  async edit(groupId: string, messageId: string, raw: string, added: readonly GroupMention[] = []): Promise<GroupEditResult> {
    const refuse = (error: string) => ({ error, refused: true });
    const membership = this.host.membership(groupId);
    if (!membership) return refuse("You are not in this group");
    if (typeof messageId !== "string" || typeof raw !== "string") return refuse("No message to edit");
    const chat = chatOf(groupId);
    const message = await this.find(chat, messageId);
    if (!message || !canEditInGroup(message)) return refuse("Only your own text messages can be edited");
    const text = raw.trim();
    if (!text) return refuse("An edit cannot be empty. Delete the message instead.");
    if (utf8Encode(text).length > GROUP_EDIT_TEXT_BYTES) return refuse(`Message exceeds ${GROUP_EDIT_TEXT_BYTES} UTF-8 bytes.`);
    // Everyone: a private group's admin only (the group checks it against the admin of the message's epoch again).
    const mentions = carryMentions(message, text, Array.isArray(added) ? added : [], !membership.community && !!membership.admin);
    if (text === message.text && JSON.stringify(mentions) === JSON.stringify(message.mentions ?? [])) return { error: null, messageId };
    const seq = (message.edit?.seq ?? 0) + 1;
    if (seq > MAX_EDITS_PER_MESSAGE) return refuse(`This message was edited ${MAX_EDITS_PER_MESSAGE} times, the most one takes.`);
    const at = this.now();
    await this.host.patch(chat, messageId, current => {
      const next = withEdit(current, { seq, at, text, pending: true });
      return { text: next.text, edit: next.edit, mentions: mentions.length ? mentions : undefined };
    });
    await this.host.changed(chat, messageId);
    // One pass: said now when the pace allows (then it is no longer pending), else a timer says it later.
    await this.flush(groupId).catch(() => {});
    return { error: null, messageId };
  }

  /** Says my pending edits in a group, oldest first, at the pace allowed; what waits goes when the window has room. */
  flush(groupId: string): Promise<void> {
    const running = this.flushing.get(groupId);
    if (running) return running.then(() => this.flush(groupId));
    const run = this.run(groupId).finally(() => this.flushing.delete(groupId));
    this.flushing.set(groupId, run);
    return run;
  }

  private async run(groupId: string): Promise<void> {
    clearTimeout(this.timers.get(groupId));
    this.timers.delete(groupId);
    if (this.stopped || !this.host.membership(groupId)) return;
    const chat = chatOf(groupId), now = this.now();
    const due = (await this.host.messages(chat)).filter(m => m.sender === "me" && m.edit?.pending).sort((a, b) => a.edit!.at - b.edit!.at);
    let pace = this.sendPace.get(groupId);
    if (!pace) this.sendPace.set(groupId, pace = new RateWindow(EDIT_SEND_LIMIT, EDIT_RATE_WINDOW_MS, this.now));
    let retry = Infinity;
    for (const message of due) {
      const edit = message.edit!;
      // Not said for as long as a message is tried: given up on, the text stays as it is here.
      if (now - edit.at >= RESEND_POLICY.windowMs) { await this.settle(chat, message.id, edit.seq); continue; }
      if (!pace.take()) { retry = Math.min(retry, pace.wait()); break; }
      const error = await this.host.send(groupId, { id: message.id, e: edit.seq, ts: edit.at, m: message.text, ...(message.mentions?.length && { k: message.mentions }) });
      if (error) { retry = Math.min(retry, RETRY_MS); continue; }
      await this.settle(chat, message.id, edit.seq);
    }
    if (Number.isFinite(retry) && !this.stopped) this.timers.set(groupId, setTimeout(() => { void this.flush(groupId).catch(() => {}); }, Math.max(50, retry)));
  }

  private async find(chat: string, id: string): Promise<StoredMessage | undefined> {
    return this.host.message ? this.host.message(chat, id) : (await this.host.messages(chat)).find(m => m.id === id);
  }

  private async settle(chat: string, id: string, seq: number): Promise<void> {
    const updated = await this.host.patch(chat, id, current => {
      if (!current.edit?.pending || current.edit.seq !== seq) return null;
      const { pending: _said, ...edit } = current.edit;
      return { edit };
    });
    if (updated) await this.host.changed(chat, id);
  }

  /**
   * An edit from a member, authenticated as `sender` by the group. Believed only while the sender is in the group (a
   * removed member's edits are dropped) and only of the sender's own message; the highest number wins. One of a message
   * not here yet waits a minute for it. Past `EDIT_RECEIVE_LIMIT` a window from one member, the rest are dropped.
   */
  async receive(groupId: string, sender: string, edit: GroupEdit): Promise<"applied" | "stale" | "waiting" | "dropped"> {
    const membership = this.host.membership(groupId);
    if (!membership?.members.has(sender) || sender === membership.me || !edit.id.startsWith(`${sender}:`)) return "dropped";
    const key = `${groupId}\n${sender}`;
    let pace = this.receivePace.get(key);
    if (!pace) this.receivePace.set(key, pace = new RateWindow(EDIT_RECEIVE_LIMIT, EDIT_RATE_WINDOW_MS, this.now));
    if (!pace.take()) return "dropped";
    const chat = chatOf(groupId);
    const message = await this.find(chat, edit.id);
    if (!message) { this.buffer.hold(chat, { ...edit, sender }); return "waiting"; }
    return this.apply(chat, membership.me, sender, message, edit);
  }

  /** A member's message was stored: an edit that came before it is shown now. */
  async stored(message: StoredMessage): Promise<void> {
    if (message.sender !== "peer" || !message.linkId.startsWith("group:")) return;
    const early = this.buffer.take(message.linkId, message.id);
    const membership = early && this.host.membership(message.linkId.slice("group:".length));
    if (early && membership?.members.has(early.sender)) await this.apply(message.linkId, membership.me, early.sender, message, early);
  }

  private async apply(chat: string, me: string, sender: string, message: StoredMessage, edit: GroupEdit): Promise<"applied" | "stale" | "dropped"> {
    const takes = (m: StoredMessage) => takesPeerEdit(m) && m.member === sender;
    if (!takes(message)) return "dropped";
    if ((message.edit?.seq ?? 0) >= edit.e) return "stale";
    const updated = await this.host.patch(chat, message.id, current => {
      if (!takes(current) || (current.edit?.seq ?? 0) >= edit.e) return null;
      const next = withEdit(current, { seq: edit.e, at: receivedTimestamp(edit.ts), text: edit.m });
      // Who it names now shows as such; an edit that names me is never a new mention (no sound, no @ in the list).
      return { text: next.text, edit: next.edit, mentions: edit.k?.length ? edit.k : undefined, mentioned: mentionsMember(edit.k, me) ? true : undefined };
    });
    if (!updated) return "stale";
    await this.host.changed(chat, message.id);
    return "applied";
  }

  /** An edge of a private group opened: the member at its other end hears my latest edits again, in case it missed them. */
  async resend(groupId: string, to: string): Promise<void> {
    const mine = (await this.host.messages(chatOf(groupId)))
      .filter(m => m.sender === "me" && m.edit && !m.edit.pending && canEditInGroup(m))
      .sort((a, b) => b.edit!.at - a.edit!.at).slice(0, GROUP_EDIT_RESEND).reverse();
    // One that cannot go (its epoch's key is gone) does not hold the others back.
    for (const m of mine) await this.host.send(groupId, { id: m.id, e: m.edit!.seq, ts: m.edit!.at, m: m.text, ...(m.mentions?.length && { k: m.mentions }) }, to);
  }

  forget(groupId: string): void {
    clearTimeout(this.timers.get(groupId));
    this.timers.delete(groupId);
    this.buffer.forget(chatOf(groupId));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
