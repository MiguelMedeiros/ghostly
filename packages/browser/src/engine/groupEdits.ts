import {
  EDIT_RATE_WINDOW_MS, EDIT_RECEIVE_LIMIT, EDIT_SEND_LIMIT, GROUP_EDIT_TEXT_BYTES, MAX_EDITS_PER_MESSAGE, RateWindow, STATUS_CARD_LIMITS, carryMentions, mentionsMember, heardTime, utf8Encode,
  type GroupEdit, type GroupMention, type StatusCard,
} from "@ghostly/core";
import { GROUP_MESSAGE_ID, canEditInGroup, canRemove, isJoinNotice, takesPeerEdit, withEdit } from "../shared/edits";
import type { StoredMessage } from "../shared/types";
import { CardEditPacer, EditBuffer } from "./edits";
import { removalNumber, type Removal } from "./removals";
import { RESEND_POLICY } from "./outbox";

/*
 * Edits in groups (WISP 902 § Edits, both profiles), as the engine keeps them: on the message's row, the highest edit
 * number winning, the versions it replaces in its history, as in a 1:1 chat (WISP 400 § Edits). How an edit travels is
 * the group's (`send`): a private group's `group-edit` frames over the edges, a community's application frame.
 *
 * A group has no receipts: my edit is pending only until it was said to the group, at most `EDIT_SEND_LIMIT` per window
 * per group (a bot rewriting a status says only its latest text). A private group's member whose edge was down hears
 * every edit of mine it has not heard on that edge when it opens (`resend`); a community's members catch up from each other.
 */

export interface GroupEditsHost {
  messages(chat: string): Promise<StoredMessage[]>;
  /** The chat's history for `resend`: one read shared by the edges that open together (`messages` when not given). */
  history?(chat: string): Promise<StoredMessage[]>;
  /** One row by its id (`db.getMessage`): an edit names its message so, and a long group is not read whole for it. */
  message?(chat: string, id: string): Promise<StoredMessage | undefined>;
  /** Changes one row in place (`db.patchMessage`); undefined when the row is gone or nothing changed. */
  patch(chat: string, id: string, change: (message: StoredMessage) => Partial<StoredMessage> | null): Promise<StoredMessage | undefined>;
  /** Row `id` of the chat changed: the pages hear it. Never a new message: no sound, no unread, no move in the list. */
  changed(chat: string, id: string): Promise<void> | void;
  /** My key in an active group, who is in it now, whether it is a community, and whether I am its admin. */
  membership(groupId: string): { me: string; members: ReadonlySet<string>; community: boolean; admin?: boolean } | undefined;
  /**
   * A member deleted its message for everyone (WISP 400 § Delete for everyone): it goes from this device with its file,
   * and its id is kept so a copy that comes again stays gone. Also for a message not here yet.
   */
  remove(chat: string, id: string): Promise<void>;
  /**
   * I deleted my message for everyone: it goes from this device as a member's removal does (`remove`), and from now on
   * it reads as a row of mine whose edit is the removal (`removalRow`): pending until said, then said again to an edge
   * that opens.
   */
  removeMine(chat: string, message: StoredMessage, removal: Removal): Promise<void>;
  /** Says an edit to the group (a private group's: to member `to` alone, when given). An error when it could not go now. */
  send(groupId: string, edit: GroupEdit, to?: string): Promise<string | null>;
  /**
   * The open edge of a private group to a member, as what tells one connection from the next; undefined while it is
   * down. `resend` says nothing to an edge that is down and goes on only while it is the same. Not given: always up.
   */
  edge?(groupId: string, member: string): unknown;
  now?(): number;
}

/** What `edit` answers: `refused` when it is not something to edit (the page says so and keeps the edit open). */
export interface GroupEditResult { error: string | null; refused?: boolean; messageId?: string }

/** My edits said again on an edge in one window (`GROUP_EDIT_RESEND_WINDOW_MS`): below what a receiver takes in one. */
export const GROUP_EDIT_RESEND = 16;
/** A second past the receiver's window, so one window's edits have left it on the member's side whatever the edge's delay. */
export const GROUP_EDIT_RESEND_WINDOW_MS = EDIT_RATE_WINDOW_MS + 1_000;
/** An edge that opens for the first time since the app started hears my newest edits again, this many messages at most. */
export const GROUP_EDIT_CATCH_UP = 256;
/** Members' edits past what a window takes, kept per group until it has room: as many as a community's store hands back. */
export const GROUP_EDITS_HELD = 256;
/** An edit that could not go (no epoch key yet) is tried again after this long. */
const RETRY_MS = 10_000;

const chatOf = (groupId: string) => `group:${groupId}`;
/** What a row of mine says to the group as its latest edit: a removal its fallback text alone (WISP 400 § Delete for everyone). */
const said = (m: StoredMessage): GroupEdit => m.removed ? { id: m.id, e: m.edit!.seq, ts: m.edit!.at, m: m.text, rm: true }
  : { id: m.id, e: m.edit!.seq, ts: m.edit!.at, m: m.text, ...(m.mentions?.length && { k: m.mentions }), ...(m.card && { sc: m.card }) };
const resendKey = (groupId: string, member: string) => `${groupId}\n${member}`;

export class GroupEdits {
  private readonly now: () => number;
  private readonly buffer: EditBuffer<GroupEdit & { sender: string }>;
  /** Members' status card updates, applied at most once a second per message (WISP 405 · Status Cards). */
  private readonly cards: CardEditPacer;
  private readonly sendPace = new Map<string, RateWindow>();
  private readonly receivePace = new Map<string, RateWindow>();
  /** Per group, per member (`group\nmember`): its edits past the window, by message, waiting for room (`hold`). */
  private readonly held = new Map<string, Map<string, Map<string, GroupEdit>>>();
  private readonly heldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushing = new Map<string, Promise<void>>();
  /** Per group: my rows known to have an edit to say, each with when it was last told (`edit`), by `tick`. */
  private readonly known = new Map<string, Map<string, number>>();
  /**
   * Per group and member (`resendKey`): the last edit of mine said on its edge, in the order `resend` says them. What
   * comes after it is what the member has not heard there. Not kept across a restart.
   */
  private readonly heard = new Map<string, { at: number; id: string }>();
  /** The connection `resend` last spoke on, per group and member: a new one hears my latest edits again. */
  private readonly resentOn = new Map<string, unknown>();
  private readonly resendPace = new Map<string, RateWindow>();
  private readonly resendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resending = new Map<string, Promise<void>>();
  private tick = 0;
  /**
   * The groups whose history was read for the rows with an edit to say: `known` has them all, and from then on those
   * rows alone are read (`host.message`). An edit costs what it does in a short group, however long this one is.
   */
  private readonly learnt = new Set<string>();
  private stopped = false;

  constructor(private readonly host: GroupEditsHost) {
    this.now = host.now ?? Date.now;
    this.buffer = new EditBuffer(this.now);
    this.cards = new CardEditPacer(this.now);
  }

  /**
   * Edits a text of mine in a group: the new text here at once, and to the group as soon as the pace allows. Mentions
   * the message had stay where their words still are; `added` are those picked while editing. `card`: the status card
   * of the new version, already checked (WISP 405 · Status Cards); a card message then takes `STATUS_CARD_LIMITS.edits`.
   */
  async edit(groupId: string, messageId: string, raw: string, added: readonly GroupMention[] = [], card?: StatusCard): Promise<GroupEditResult> {
    const refuse = (error: string) => ({ error, refused: true });
    const membership = this.host.membership(groupId);
    if (!membership) return refuse("You are not in this group");
    if (typeof messageId !== "string" || typeof raw !== "string") return refuse("No message to edit");
    const chat = chatOf(groupId);
    const message = await this.find(chat, messageId);
    if (!message || !canEditInGroup(message)) return refuse("Only your own text messages can be edited");
    const text = raw.trim();
    if (!text) return refuse("An edit cannot be empty. Delete the message instead.");
    if (isJoinNotice(text)) return refuse("An edit cannot read as a join notice.");
    if (utf8Encode(text).length > GROUP_EDIT_TEXT_BYTES) return refuse(`Message exceeds ${GROUP_EDIT_TEXT_BYTES} UTF-8 bytes.`);
    // Everyone: a private group's admin only (the group checks it against the admin of the message's epoch again).
    const mentions = carryMentions(message, text, Array.isArray(added) ? added : [], !membership.community && !!membership.admin);
    if (text === message.text && JSON.stringify(mentions) === JSON.stringify(message.mentions ?? []) && JSON.stringify(card ?? null) === JSON.stringify(message.card ?? null)) return { error: null, messageId };
    const seq = (message.edit?.seq ?? 0) + 1, most = card ? STATUS_CARD_LIMITS.edits : MAX_EDITS_PER_MESSAGE;
    if (seq > most) return refuse(`This message was edited ${most} times, the most one takes.`);
    const at = this.now();
    await this.host.patch(chat, messageId, current => {
      const next = withEdit(current, { seq, at, text, card, pending: true });
      return { text: next.text, edit: next.edit, card: next.card, mentions: mentions.length ? mentions : undefined };
    });
    // Told once the row says so: a look that read it as said meanwhile must not forget it.
    // Told once the row says so: a look that read it as said meanwhile must not forget it.
    if (this.host.message) this.told(groupId).set(messageId, ++this.tick);
    await this.host.changed(chat, messageId);
    // One pass: said now when the pace allows (then it is no longer pending), else a timer says it later.
    await this.flush(groupId).catch(() => {});
    return { error: null, messageId };
  }

  /**
   * Deletes a message of mine for everyone (WISP 400 § Delete for everyone): gone here at once, and its removal said to
   * the group as the message's last edit, at the pace of edits. A text, a card, a file or a voice message; never a
   * payment, a note or an event line.
   */
  async removeMine(groupId: string, messageId: string): Promise<GroupEditResult> {
    const refuse = (error: string) => ({ error, refused: true });
    if (!this.host.membership(groupId)) return refuse("You are not in this group");
    const chat = chatOf(groupId);
    const message = typeof messageId === "string" ? await this.find(chat, messageId) : undefined;
    if (!message || message.removed || message.sender !== "me" || !GROUP_MESSAGE_ID.test(message.id)) return refuse("Only your own messages can be deleted for everyone");
    if (!canRemove(message)) return refuse("A payment, a request or a notice cannot be deleted for everyone");
    await this.host.removeMine(chat, message, { id: message.id, e: removalNumber(message.edit?.seq), at: this.now(), pending: true });
    if (this.host.message) this.told(groupId).set(messageId, ++this.tick);
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
    const due = (await this.pending(groupId)).sort((a, b) => a.edit!.at - b.edit!.at);
    let pace = this.sendPace.get(groupId);
    if (!pace) this.sendPace.set(groupId, pace = new RateWindow(EDIT_SEND_LIMIT, EDIT_RATE_WINDOW_MS, this.now));
    let retry = Infinity;
    for (const message of due) {
      const edit = message.edit!;
      // Not said for as long as a message is tried: given up on, the text stays as it is here.
      if (now - edit.at >= RESEND_POLICY.windowMs) { await this.settle(chat, message.id, edit.seq); continue; }
      if (!pace.take()) { retry = Math.min(retry, pace.wait()); break; }
      const error = await this.host.send(groupId, said(message));
      if (error) { retry = Math.min(retry, RETRY_MS); continue; }
      await this.settle(chat, message.id, edit.seq);
    }
    if (Number.isFinite(retry) && !this.stopped) this.timers.set(groupId, setTimeout(() => { void this.flush(groupId).catch(() => {}); }, Math.max(50, retry)));
  }

  /**
   * My rows of a group with an edit to say. The group's whole history is read for them once (always, with no
   * `host.message` to read one by); after that the known rows alone, and one that waits no more is forgotten, unless
   * it was told again while it was read.
   */
  private async pending(groupId: string): Promise<StoredMessage[]> {
    const waits = (m: StoredMessage) => m.sender === "me" && !!m.edit?.pending;
    const chat = chatOf(groupId), read = this.host.message;
    if (!read || !this.learnt.has(groupId)) {
      const rows = (await this.host.messages(chat)).filter(waits);
      if (!read) return rows;
      for (const m of rows) if (!this.told(groupId).has(m.id)) this.told(groupId).set(m.id, this.tick);
      this.learnt.add(groupId);
      return rows;
    }
    const known = this.told(groupId), asOf = this.tick, ids = [...known.keys()];
    const rows = await Promise.all(ids.map(id => read(chat, id)));
    return rows.filter((m, i): m is StoredMessage => {
      if (m && waits(m)) return true;
      if ((known.get(ids[i]) ?? 0) <= asOf) known.delete(ids[i]);
      return false;
    });
  }

  private told(groupId: string): Map<string, number> {
    let known = this.known.get(groupId);
    if (!known) this.known.set(groupId, known = new Map());
    return known;
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
   * not here yet waits a minute for it. Past `EDIT_RECEIVE_LIMIT` a window from one member, the rest wait for the next
   * window (`hold`): a catch-up hands back every edit of an author at once, and one dropped is never handed again.
   */
  async receive(groupId: string, sender: string, edit: GroupEdit): Promise<"applied" | "stale" | "waiting" | "dropped"> {
    const membership = this.host.membership(groupId);
    if (!membership?.members.has(sender) || sender === membership.me || !edit.id.startsWith(`${sender}:`)) return "dropped";
    const key = `${groupId}\n${sender}`;
    let pace = this.receivePace.get(key);
    if (!pace) this.receivePace.set(key, pace = new RateWindow(EDIT_RECEIVE_LIMIT, EDIT_RATE_WINDOW_MS, this.now));
    // Behind those that wait already, so a member's edits are taken in the order they came.
    if (this.held.get(groupId)?.has(key) || !pace.take()) return this.hold(groupId, sender, edit, pace);
    return this.take(groupId, membership, sender, edit);
  }

  /**
   * An edit past what a member's window takes: kept, the highest number per message, `GROUP_EDITS_HELD` messages a
   * group at most (the oldest go first), and taken when the window has room. The work stays what the window allows.
   */
  private hold(groupId: string, sender: string, edit: GroupEdit, pace: RateWindow): "waiting" | "dropped" {
    const key = `${groupId}\n${sender}`;
    let group = this.held.get(groupId);
    if (!group) this.held.set(groupId, group = new Map());
    let waiting = group.get(key);
    if (!waiting) group.set(key, waiting = new Map());
    const known = waiting.get(edit.id);
    if (known && known.e >= edit.e) return "dropped";
    waiting.delete(edit.id);
    waiting.set(edit.id, edit);
    let count = 0;
    for (const member of group.values()) count += member.size;
    for (const [member, edits] of group) {
      if (count <= GROUP_EDITS_HELD) break;
      while (count > GROUP_EDITS_HELD && edits.size) { edits.delete(edits.keys().next().value!); count--; }
      if (!edits.size && member !== key) group.delete(member);
    }
    if (!this.heldTimers.has(key) && !this.stopped) this.heldTimers.set(key, setTimeout(() => { void this.takeHeld(groupId, sender).catch(() => {}); }, Math.max(50, pace.wait())));
    return waiting.has(edit.id) ? "waiting" : "dropped";
  }

  /** The window of a member has room again: its edits that waited are taken, oldest first, as many as it allows. */
  private async takeHeld(groupId: string, sender: string): Promise<void> {
    const key = `${groupId}\n${sender}`;
    this.heldTimers.delete(key);
    const group = this.held.get(groupId), waiting = group?.get(key), pace = this.receivePace.get(key);
    if (this.stopped || !group || !waiting || !pace) return;
    for (const [id, edit] of [...waiting]) {
      const membership = this.host.membership(groupId);
      // Out of the group meanwhile (the member, or me): nothing of it is believed.
      if (!membership?.members.has(sender)) { waiting.clear(); break; }
      if (!pace.take()) break;
      // Unless a higher one took its place while the last was applied.
      if (waiting.get(id) !== edit) continue;
      waiting.delete(id);
      await this.take(groupId, membership, sender, edit).catch(() => {});
    }
    if (waiting.size) { if (!this.heldTimers.has(key) && !this.stopped) this.heldTimers.set(key, setTimeout(() => { void this.takeHeld(groupId, sender).catch(() => {}); }, Math.max(50, pace.wait()))); return; }
    if (group.get(key) === waiting) group.delete(key);
    if (!group.size) this.held.delete(groupId);
  }

  private async take(groupId: string, membership: { me: string }, sender: string, edit: GroupEdit): Promise<"applied" | "stale" | "waiting" | "dropped"> {
    const chat = chatOf(groupId);
    const message = await this.find(chat, edit.id);
    // A removal is final, whatever it numbers and whatever the message is (a file too): only the author's own.
    if (edit.rm) {
      if (message && (message.sender !== "peer" || message.member !== sender || !canRemove(message))) return "dropped";
      await this.host.remove(chat, edit.id);
      return "applied";
    }
    if (!message) { this.buffer.hold(chat, { ...edit, sender }); return "waiting"; }
    // A card's update: paced per message, the highest number of those that came meanwhile applied when the time is up.
    if (edit.sc && message.member === sender && (message.edit?.seq ?? 0) < edit.e) {
      await this.cards.take(`${chat}\n${message.id}`, edit.e, async () => { await this.apply(chat, membership.me, sender, message, edit); });
      return "applied";
    }
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
    const takes = (m: StoredMessage) => takesPeerEdit(m, edit.m) && m.member === sender;
    if (!takes(message)) return "dropped";
    if ((message.edit?.seq ?? 0) >= edit.e) return "stale";
    const updated = await this.host.patch(chat, message.id, current => {
      if (!takes(current) || (current.edit?.seq ?? 0) >= edit.e) return null;
      const next = withEdit(current, { seq: edit.e, at: heardTime(edit.ts), text: edit.m, card: edit.sc });
      // Who it names now shows as such; an edit that names me is never a new mention (no sound, no @ in the list).
      return { text: next.text, edit: next.edit, card: next.card, mentions: edit.k?.length ? edit.k : undefined, mentioned: mentionsMember(edit.k, me) ? true : undefined };
    });
    if (!updated) return "stale";
    await this.host.changed(chat, message.id);
    return "applied";
  }

  /**
   * An edge of a private group opened: the member at its other end hears the edits of mine it has not heard on that
   * edge, the latest of each message, oldest first. `GROUP_EDIT_RESEND` go a window and the rest a window later each,
   * while the edge is the same: a member away while I closed forty task cards reads them all as closed, not the latest
   * sixteen. Nothing known of what it heard (the first time since the app started): my newest `GROUP_EDIT_CATCH_UP`.
   * A new connection hears my latest `GROUP_EDIT_RESEND` again whatever it heard: one may have come before its message
   * and been dropped. Called again while the edge is the same, it goes on from where it was.
   */
  resend(groupId: string, to: string): Promise<void> {
    const key = resendKey(groupId, to);
    const run = (this.resending.get(key) ?? Promise.resolve()).then(() => this.resendNow(groupId, to));
    const settled = run.catch(() => {}).finally(() => { if (this.resending.get(key) === settled) this.resending.delete(key); });
    this.resending.set(key, settled);
    return run;
  }

  private async resendNow(groupId: string, to: string): Promise<void> {
    const key = resendKey(groupId, to), chat = chatOf(groupId);
    clearTimeout(this.resendTimers.get(key));
    this.resendTimers.delete(key);
    const open = () => this.host.edge ? this.host.edge(groupId, to) : true;
    const edge = open(), membership = this.host.membership(groupId);
    if (this.stopped || edge === undefined || !membership || membership.community || !membership.members.has(to)) return;
    const mine = (await (this.host.history ? this.host.history(chat) : this.host.messages(chat)))
      .filter(m => m.sender === "me" && m.edit && !m.edit.pending && canEditInGroup(m))
      .sort((a, b) => a.edit!.at - b.edit!.at || (a.id < b.id ? -1 : 1));
    const last = this.heard.get(key);
    const after = (m: StoredMessage) => !last || m.edit!.at > last.at || (m.edit!.at === last.at && m.id > last.id);
    const unheard = last ? mine.filter(after).length : Math.min(mine.length, GROUP_EDIT_CATCH_UP);
    const again = this.resentOn.get(key) === edge ? 0 : Math.min(mine.length, GROUP_EDIT_RESEND);
    this.resentOn.set(key, edge);
    const due = mine.slice(mine.length - Math.max(unheard, again));
    let pace = this.resendPace.get(key);
    if (!pace) this.resendPace.set(key, pace = new RateWindow(GROUP_EDIT_RESEND, GROUP_EDIT_RESEND_WINDOW_MS, this.now));
    for (const m of due) {
      if (this.stopped || open() !== edge) return;
      if (!pace.take()) {
        this.resendTimers.set(key, setTimeout(() => { void this.resend(groupId, to).catch(() => {}); }, Math.max(50, pace.wait())));
        return;
      }
      // One that cannot go (its epoch's key is gone) does not hold the others back.
      await this.host.send(groupId, said(m), to);
      // Heard only when the edge that took it is still the one that was open.
      if (open() !== edge) return;
      if (after(m)) this.heard.set(key, { at: m.edit!.at, id: m.id });
    }
  }

  /** A group is forgotten, or the app stops: what was known of its members' edges goes with it. */
  private dropResends(groupId?: string): void {
    const of = (key: string) => groupId === undefined || key.startsWith(`${groupId}\n`);
    for (const [key, timer] of this.resendTimers) if (of(key)) { clearTimeout(timer); this.resendTimers.delete(key); }
    for (const key of [...this.heard.keys()]) if (of(key)) this.heard.delete(key);
    for (const key of [...this.resendPace.keys()]) if (of(key)) this.resendPace.delete(key);
    for (const key of [...this.resentOn.keys()]) if (of(key)) this.resentOn.delete(key);
  }

  forget(groupId: string): void {
    clearTimeout(this.timers.get(groupId));
    this.timers.delete(groupId);
    this.known.delete(groupId);
    this.learnt.delete(groupId);
    this.dropResends(groupId);
    this.dropHeld(groupId);
    this.buffer.forget(chatOf(groupId));
  }

  stop(): void {
    this.stopped = true;
    this.cards.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dropResends();
    this.dropHeld();
  }

  private dropHeld(groupId?: string): void {
    for (const [key, timer] of this.heldTimers) if (groupId === undefined || key.startsWith(`${groupId}\n`)) { clearTimeout(timer); this.heldTimers.delete(key); }
    if (groupId === undefined) this.held.clear(); else this.held.delete(groupId);
  }
}
