import { REACTION_LIMITS, ReactionWindow, nextReactionNumber, reactionEmoji, reactionIsNewer, replySnippet, type WireReaction } from "@ghostly/core";
import { replyRef } from "../shared/replies";
import type { ReactionNote, StoredMessage } from "../shared/types";

/*
 * Reactions to messages (WISP 400 § Reactions), as the engine keeps them: on the message's row, one per person, the
 * highest number winning. How they travel is the caller's: a 1:1 chat's session or DHT envelopes, a group's frames.
 * A chat is named as the engine files its messages: a link id, or `group:<id>`.
 */

export interface ReactionsHost {
  messages(chat: string): Promise<StoredMessage[]>;
  /** One row by its id (`db.getMessage`): the row a reaction names is found so first, and a long chat is not read whole. */
  message?(chat: string, id: string): Promise<StoredMessage | undefined>;
  /** Changes one row in place (`db.patchMessage`); undefined when the row is gone. */
  patch(chat: string, id: string, change: (message: StoredMessage) => Partial<StoredMessage> | null): Promise<StoredMessage | undefined>;
  /** Row `id` of the chat changed: the pages hear it. `note`: its latest reaction, when this one is it. */
  changed(chat: string, id: string, note?: ReactionNote): Promise<void> | void;
  /** Someone reacted to a message of mine: a quiet notice (the pages mute it with the chat). */
  notify?(chat: string, key: string): void;
  now?(): number;
}

/** Why a reaction is not kept: said to whoever asked for it. */
export type ReactionRefusal = string;

/** Where a received reaction went: shown, older than what is shown, waiting for its message, or dropped (no room). */
export type ReactionOutcome = "applied" | "stale" | "waiting" | "dropped";

const isGroup = (chat: string) => chat.startsWith("group:");

/** The row a reaction names in a chat: the id both sides know it by (`replyRef`). */
export function reactionTarget(messages: readonly StoredMessage[], id: string, group: boolean): StoredMessage | undefined {
  return messages.find(m => replyRef(m, group) === id);
}

/** The latest reaction shown in a chat's history, for the chat list after a restart. */
export function latestReaction(messages: readonly StoredMessage[]): ReactionNote | undefined {
  let best: ReactionNote | undefined;
  for (const message of messages) for (const [by, r] of Object.entries(message.reactions ?? {})) {
    if (r.e && (!best || r.at > best.at)) best = note(message, by, r.e, r.at);
  }
  return best;
}

function note(message: StoredMessage, by: string, emoji: string, at: number): ReactionNote {
  return { at, by, emoji, snippet: replySnippet(message.text), mine: message.sender === "me", message: message.id };
}

/** The note again after its message changed (an edit): its line is the message's text now. Undefined when nothing changed. */
export function noteAfterChange(current: ReactionNote, message: StoredMessage): ReactionNote | undefined {
  const snippet = replySnippet(message.text);
  return snippet === current.snippet ? undefined : { ...current, snippet };
}

/**
 * My reactions in a private group to say again to an edge that opened, in case it missed them: the newest `limit`, of
 * this membership only. One made before I was removed and invited again went out under my old member key; said again
 * now it would go under the new one, and every member would show it twice.
 */
export function groupReactionsToResend(messages: readonly StoredMessage[], limit: number): WireReaction[] {
  let joinedAt = 0;
  for (const m of messages) if (m.event === "joined" && !m.member) joinedAt = Math.max(joinedAt, m.timestamp);
  return messages.flatMap(m => {
    const r = m.reactions?.me, id = replyRef(m, true);
    return r && id && r.at >= joinedAt ? [{ id, e: r.e, n: r.n }] : [];
  }).sort((a, b) => b.n - a.n).slice(0, limit).reverse();
}

/** This side's highest number in a chat: the next one goes past it (and past what still waits to be confirmed). */
function lastMine(messages: readonly StoredMessage[], pending: readonly WireReaction[] = []): number {
  let last = 0;
  for (const m of messages) last = Math.max(last, m.reactions?.me?.n ?? 0);
  for (const p of pending) last = Math.max(last, p.n);
  return last;
}

export class Reactions {
  /** Reactions to messages not here yet, per chat, until `REACTION_LIMITS.bufferMs` after they came. */
  private readonly waiting = new Map<string, { by: string; reaction: WireReaction; until: number }[]>();
  /** One chat's reactions at a time: a burst for one message lands in order. */
  private queue = Promise.resolve();
  /** A group member's reactions taken per window (chat and member key), as a paired chat's session limits them. */
  private readonly memberPace = new Map<string, ReactionWindow>();

  constructor(private readonly host: ReactionsHost) {}

  private now(): number { return this.host.now?.() ?? Date.now(); }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * This side reacts (`emoji` "" takes its reaction back): shown here at once, and the wire reaction to send. The
   * message is named by its id here or the id both sides know it by. `pending`: what still waits to be confirmed in
   * this chat, which the new number must pass.
   */
  mine(chat: string, messageId: unknown, emoji: unknown, pending: readonly WireReaction[] = []): Promise<{ reaction: WireReaction; message: StoredMessage } | { error: ReactionRefusal }> {
    return this.run(async () => {
      if (typeof messageId !== "string" || !messageId) return { error: "No message to react to" };
      const e = emoji === "" ? "" : reactionEmoji(emoji);
      if (e === null) return { error: "A reaction is one emoji" };
      const messages = await this.host.messages(chat), group = isGroup(chat);
      const target = messages.find(m => m.id === messageId) ?? reactionTarget(messages, messageId, group);
      const id = target && replyRef(target, group);
      if (!target || !id) return { error: "That message is not in this chat, or takes no reaction" };
      const current = target.reactions?.me;
      if (!e && !current?.e) return { error: "No reaction of yours to take back" };
      const reaction: WireReaction = { id, e, n: nextReactionNumber(lastMine(messages, pending), this.now()) };
      const message = await this.write(chat, target, "me", reaction) ?? target;
      return { reaction, message };
    });
  }

  /**
   * A reaction that came from `by` (`peer`, or a member's key), already authenticated as theirs. A message not here
   * yet keeps it for a minute; past the room for that, it is dropped (and, on a 1:1 session, not confirmed).
   */
  receive(chat: string, by: string, reaction: WireReaction): Promise<ReactionOutcome> {
    if (isGroup(chat)) {
      const key = `${chat}\n${by}`;
      let pace = this.memberPace.get(key);
      if (!pace) this.memberPace.set(key, pace = new ReactionWindow(REACTION_LIMITS.receive, REACTION_LIMITS.windowMs, () => this.now()));
      if (!pace.take()) return Promise.resolve("dropped");
    }
    return this.run(async () => {
      const target = await this.find(chat, reaction.id);
      if (!target) return this.wait(chat, by, reaction);
      if (!reactionIsNewer(target.reactions?.[by], reaction.n)) return "stale";
      await this.write(chat, target, by, reaction);
      return "applied";
    });
  }

  /** A message was kept: the reactions that waited for it are shown now. */
  stored(message: StoredMessage): Promise<void> {
    const list = this.waiting.get(message.linkId);
    if (!list?.length) return Promise.resolve();
    const id = replyRef(message, isGroup(message.linkId));
    if (!id || !list.some(w => w.reaction.id === id)) return Promise.resolve();
    return this.run(async () => {
      const now = this.now(), all = (this.waiting.get(message.linkId) ?? []).filter(w => w.until > now);
      const mine = all.filter(w => w.reaction.id === id).sort((a, b) => a.reaction.n - b.reaction.n);
      this.waiting.set(message.linkId, all.filter(w => w.reaction.id !== id));
      for (const { by, reaction } of mine) {
        const target = reactionTarget(await this.host.messages(message.linkId), id, isGroup(message.linkId));
        if (target && reactionIsNewer(target.reactions?.[by], reaction.n)) await this.write(message.linkId, target, by, reaction);
      }
    });
  }

  /**
   * The row a received reaction names. Most often the row of that id (a group's), or of `peer_` or `me_` and that id (a
   * chat's): those are read alone. Any other (a file's, a payment's, one not here yet) is looked for in the whole chat.
   */
  private async find(chat: string, id: string): Promise<StoredMessage | undefined> {
    const group = isGroup(chat);
    if (this.host.message) {
      for (const rowId of group ? [id] : [`peer_${id}`, `me_${id}`]) {
        const row = await this.host.message(chat, rowId);
        if (row && replyRef(row, group) === id) return row;
      }
    }
    return reactionTarget(await this.host.messages(chat), id, group);
  }

  /** A chat is gone: nothing waits for it any more. */
  forget(chat: string): void { this.waiting.delete(chat); }

  private wait(chat: string, by: string, reaction: WireReaction): ReactionOutcome {
    const now = this.now();
    const list = (this.waiting.get(chat) ?? []).filter(w => w.until > now);
    // The same person's reaction to that message, waiting already: the newer one of the two waits.
    const same = list.find(w => w.by === by && w.reaction.id === reaction.id);
    if (same && same.reaction.n >= reaction.n) return "stale";
    const kept = list.filter(w => w !== same);
    this.waiting.set(chat, kept);
    if (kept.length >= REACTION_LIMITS.buffer) return "dropped";
    kept.push({ by, reaction, until: now + REACTION_LIMITS.bufferMs });
    return "waiting";
  }

  private async write(chat: string, target: StoredMessage, by: string, reaction: WireReaction): Promise<StoredMessage | undefined> {
    const at = this.now();
    const written = await this.host.patch(chat, target.id, row => reactionIsNewer(row.reactions?.[by], reaction.n)
      ? { reactions: { ...row.reactions, [by]: { e: reaction.e, n: reaction.n, at } } } : null);
    if (!written) return undefined;
    const shown = reaction.e ? note(written, by, reaction.e, at) : undefined;
    if (shown && by !== "me" && written.sender === "me") this.host.notify?.(chat, `${written.id}:${by}:${reaction.n}`);
    await this.host.changed(chat, written.id, shown);
    return written;
  }
}
