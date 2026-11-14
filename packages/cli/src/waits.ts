import type { GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { groupById, noMessage, nobodyJoinedChat, node, type ApiContext } from "./apiKit";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";
import { goesOn as goesOnIn } from "./waitNotice";

/*
 * Waiting on what a command sent (WISP 1100): a message's delivery, an edit's confirmation, a group frame taken by an
 * edge. Shared by the chat, group and status card methods. A deadline counts on `performance.now()`: on `Date.now()`
 * a wall clock set back while a wait ran (NTP, a person fixing the time) stretched it by as much, past the client's
 * own deadline, which told the bot to restart a sound daemon.
 */

const DELIVERY_RANK: Record<string, number> = { sending: 0, waiting: 1, queued: 1, held: 2, sent: 2, delivered: 3 };

/**
 * What a timed-out wait says of what happens next: a daemon goes on, a one-shot's profile closes now. A one-shot's
 * `edit` and `group edit` said "while this profile is online" too, as it was about to leave. Ctrl-C says the same.
 * On a chat nobody joined yet nothing goes before they do: it said "goes with this profile's next command".
 */
export const goesOn = (ctx: ApiContext, chat?: string) => chat !== undefined && nobodyJoinedChat(ctx, chat)
  ? `goes once the contact joins this chat (nobody has yet)${ctx.mode === "one-shot" ? " while this profile is online (`ghostly daemon --detach`)" : ""}`
  : ctx.mode === "daemon" && stopped(ctx) ? "goes by itself once this profile is online again" : goesOnIn(ctx.mode);

/**
 * A daemon that stops (`ApiContext.stopping`) ends every wait still open at once, with what it knows, as a timeout:
 * what was asked is done and goes on by itself. Its connections ended under the waits before, and the command failed
 * as `unavailable` "The daemon went away" with no `messageId`: a bot that sent again sent the message twice.
 */
const stopped = (ctx: ApiContext) => ctx.stopping?.aborted === true;

/** How a wait that ends short of its aim begins: its time ran out, or the daemon stopped under it. */
const ended = (ctx: ApiContext, ms: number) => stopped(ctx) ? "The daemon stopped before the wait ended" : `Timed out after ${Math.round(ms / 1000)} s`;

/** A timed-out wait's details, and `reason: "daemon-stopped"` when the daemon's stop ended it. */
const known = (ctx: ApiContext, details: Record<string, unknown>) => stopped(ctx) ? { ...details, reason: "daemon-stopped" } : details;

/** Waits until the contact confirmed the latest edit of one of my messages (it is no longer pending). */
export async function waitForEdit(ctx: ApiContext, chat: string, messageId: string, ms: number): Promise<StoredMessage> {
  const until = performance.now() + ms;
  for (;;) {
    const message = await node(ctx).getMessage(chat, messageId);
    if (!message) throw noMessage(messageId, { group: false, ref: chat });
    if (!message.edit?.pending) return message;
    if (performance.now() >= until || stopped(ctx)) throw new CliError("timeout", `${ended(ctx, ms)}: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It ${goesOn(ctx, chat)}`, known(ctx, { messageId, edits: message.edit.seq }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Waits until the contact confirmed my removal of a message, which is already gone here. */
export async function waitForRemoval(ctx: ApiContext, chat: string, messageId: string, ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (node(ctx).removalPending({ linkId: chat, messageId })) {
    if (performance.now() >= until || stopped(ctx)) throw new CliError("timeout", `${ended(ctx, ms)}: the message is gone here and the contact has not confirmed yet. Its removal ${goesOn(ctx, chat)}`, known(ctx, { messageId }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** How long `purgeMessage` waits for the engine to take the message's row out: it does so in a few milliseconds. */
const PURGE_WAIT_MS = 5_000;

/**
 * `message delete --purge`: once the message's row is gone (the engine takes it out on later turns, its files first),
 * the store's journal is folded into a fresh snapshot now, not within the hour of the fold that comes by itself: what
 * the message said leaves `db/journal.bin` and rows.db's WAL before the command answers. For a secret pasted into a
 * chat; every delete folding would rewrite the snapshot each time.
 */
export async function purgeMessage(ctx: ApiContext, chat: string, messageId: string): Promise<void> {
  const until = performance.now() + PURGE_WAIT_MS;
  let gone = !(await node(ctx).getMessage(chat, messageId));
  while (!gone && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    gone = !(await node(ctx).getMessage(chat, messageId));
  }
  await ctx.runtime.store.compact();
  if (!gone) throw new CliError("timeout", `Timed out after ${PURGE_WAIT_MS / 1000} s: the message is deleted, but what it said may stay in the profile's store until its next fold (within the hour)`, { messageId, deleted: messageId });
}

/**
 * A private group with no member but me (they all left, or nobody accepted an invitation yet): what I send there now
 * reaches nobody, not even a member who joins later (a joiner reads nothing from before). A community's roster may not
 * list every member yet, so only a private group counts.
 */
export const nobodyElseIn = (ctx: ApiContext, groupId: string): boolean => alone(groupIn(ctx, groupId));

/** A group as the engine shows it, built alone: `getState()` builds a view of every chat, once per poll. */
const groupIn = (ctx: ApiContext, groupId: string): GroupView | undefined => groupById(ctx, groupId);

const alone = (group: GroupView | undefined): boolean => group?.profile === "mesh" && !group.members.some((m) => !m.me);

/**
 * Why I am no longer in a group (removed, say), or null while I am. A member removed while away learns it only after
 * it is back, so what it sent in between is never taken, and from then on nothing goes. A community's `lost` is not
 * out: it asks to be let in again by itself.
 */
const outOf = (group: GroupView | undefined): string | null =>
  group?.status && group.status !== "active" && group.status !== "lost" ? group.statusReason ?? "You are not in this group" : null;

/**
 * Waits until an edge took my group message, or its edit number `edit`, or my reaction to it numbered `reaction`, or my
 * pin numbered `pin` (WISP 902: a group has no receipts, so this is as far as the author sees): a member's edge in a
 * private group, an edge to one of my hubs in a community. In a private group with nobody else in it, 0 at once: no
 * edge will ever take it, and the wait sat its whole time, then said "it goes when one opens" and exited 4, which a
 * bot retries, sending it again each time. Refused as soon as I learn I am out of the group: it sat its whole time
 * there too and said the same, though nothing goes any more.
 */
export async function waitForGroupFrame(ctx: ApiContext, groupId: string, messageId: string, edit: number | { reaction: number } | { pin: number } | undefined, ms: number): Promise<number> {
  const until = performance.now() + ms;
  const which = typeof edit === "object" ? edit : edit ? { edit } : {};
  for (;;) {
    const taken = node(ctx).groupTaken({ groupId, messageId, ...which });
    if (taken > 0) return taken;
    const group = groupIn(ctx, groupId);
    if (alone(group)) return taken;
    const out = outOf(group);
    if (out) throw new CliError("refused", `${out}: no member took it, and it no longer goes`, { messageId, ...("edit" in which ? { edits: which.edit } : which) });
    if (performance.now() >= until || stopped(ctx)) throw new CliError("timeout", `${ended(ctx, ms)}: no member's edge took it yet (it stays in the group and goes when one opens). It ${goesOn(ctx)}`, known(ctx, { messageId, ...("edit" in which ? { edits: which.edit } : which) }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A one-shot whose text went over the live link waits this long for its receipt before it leaves (`waitForMessage`).
 * Left at `sent`, the engine stopping took the text for unconfirmed, the next start sent it again on the DHT, and that
 * copy took the chat's one DHT text awaiting a receipt: a script's next one-shot send waited 30 s behind it, every 5-8
 * messages, and the last text showed "Connection closed before receipt" though the contact had it (agents#1640).
 */
export const ONE_SHOT_RECEIPT_MS = 2_000;

/**
 * Waits until the contact confirmed my reaction or pin in a 1:1 chat (WISP 401): until `pending` no longer finds it in
 * what the contact has not confirmed (`chatUnconfirmed`). It goes on the live session, a reaction also on the DHT
 * envelopes; one not confirmed in time is kept and said again.
 */
export async function waitForConfirmed(ctx: ApiContext, chat: string, what: "reaction" | "pin", pending: (left: { reactions: number[]; pin: number | null }) => boolean, ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (pending(node(ctx).chatUnconfirmed({ linkId: chat }))) {
    if (performance.now() >= until || stopped(ctx)) throw new CliError("timeout", `${ended(ctx, ms)}: the contact has not confirmed the ${what} yet. It is kept here and ${goesOn(ctx, chat)}`, known(ctx, { chat }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Waits until a message of mine reached `target` (`sent`: on its way to the contact; `delivered`: acknowledged). A
 * one-shot's text sent over the live link waits a moment more for its receipt (`ONE_SHOT_RECEIPT_MS`).
 */
export async function waitForMessage(ctx: ApiContext, chat: string, messageId: string, target: "sent" | "delivered", ms: number): Promise<StoredMessage> {
  const reached = await waitForDelivery(ctx, chat, messageId, target, ms);
  if (ctx.mode !== "one-shot" || target !== "sent" || reached.delivery !== "sent" || reached.via !== "datalink") return reached;
  return waitForDelivery(ctx, chat, messageId, "delivered", ONE_SHOT_RECEIPT_MS).catch(async () => (await node(ctx).getMessage(chat, messageId)) ?? reached);
}

async function waitForDelivery(ctx: ApiContext, chat: string, messageId: string, target: "sent" | "delivered", ms: number): Promise<StoredMessage> {
  const want = DELIVERY_RANK[target];
  const look = (message: StoredMessage | undefined) => {
    if (!message) return undefined;
    const delivery = message.delivery ?? "sent";
    if (delivery === "failed") throw new CliError("engine", message.deliveryError ?? "The message could not be sent", { messageId, delivery });
    return (DELIVERY_RANK[delivery] ?? 0) >= want ? message : undefined;
  };
  return new Promise<StoredMessage>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, message?: StoredMessage) => {
      if (settled) return;
      settled = true; clearTimeout(timer); off(); ctx.stopping?.removeEventListener("abort", giveUp);
      if (error) reject(error); else resolve(message!);
    };
    const check = (last = false) => void node(ctx).getMessage(chat, messageId).then((message) => {
      try {
        const done = look(message);
        if (done) finish(null, done);
        else if (last) finish(new CliError("timeout", `${ended(ctx, ms)}: the message is ${message?.delivery ?? "not sent yet"} and ${goesOn(ctx, chat)}`, known(ctx, { messageId, delivery: message?.delivery ?? null })));
      } catch (error) { finish(error); }
    }, finish);
    const giveUp = () => check(true);
    const timer = setTimeout(giveUp, ms);
    // Any event naming the message: a message first seen already delivered comes as `message.sent`, never as
    // `message.delivery`. Listening before the first read leaves no gap for a change to slip through.
    const off = ctx.hub.onEvent((event: GhostlyEvent) => {
      if (event.chat === chat && (event.messageId === messageId || (event.message as { id?: string } | undefined)?.id === messageId)) check();
    });
    if (stopped(ctx)) giveUp();
    else { ctx.stopping?.addEventListener("abort", giveUp, { once: true }); check(); }
  });
}
