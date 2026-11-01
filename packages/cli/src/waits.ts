import type { StoredMessage } from "@ghostly/browser/shared/types";
import { node, type ApiContext } from "./apiKit";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";

/*
 * Waiting on what a command sent (WISP 1100): a message's delivery, an edit's confirmation, a group frame taken by an
 * edge. Shared by the chat, group and status card methods.
 */

const DELIVERY_RANK: Record<string, number> = { sending: 0, waiting: 1, queued: 1, held: 2, sent: 2, delivered: 3 };

/**
 * What a timed-out wait says of what happens next: a daemon goes on, a one-shot's profile closes now. A one-shot's
 * `edit` and `group edit` said "while this profile is online" too, as it was about to leave.
 */
const goesOn = (ctx: ApiContext) => ctx.mode === "one-shot"
  ? "goes with this profile's next command, or keep it online with `ghostly daemon --detach`"
  : "still goes by itself while this profile is online";

/** Waits until the contact confirmed the latest edit of one of my messages (it is no longer pending). */
export async function waitForEdit(ctx: ApiContext, chat: string, messageId: string, ms: number): Promise<StoredMessage> {
  const until = Date.now() + ms;
  for (;;) {
    const message = await node(ctx).getMessage(chat, messageId);
    if (!message) throw new CliError("not_found", `No message ${messageId} in this chat`);
    if (!message.edit?.pending) return message;
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It ${goesOn(ctx)}`, { messageId, edits: message.edit.seq });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Waits until an edge took my group message, or its edit number `edit` (WISP 902: a group has no receipts, so this is
 * as far as the author sees): a member's edge in a private group, an edge to one of my hubs in a community.
 */
export async function waitForGroupFrame(ctx: ApiContext, groupId: string, messageId: string, edit: number | undefined, ms: number): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const taken = node(ctx).groupTaken({ groupId, messageId, ...(edit ? { edit } : {}) });
    if (taken > 0) return taken;
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: no member's edge took it yet (it stays in the group and goes when one opens). It ${goesOn(ctx)}`, { messageId, ...(edit ? { edits: edit } : {}) });
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
  const until = Date.now() + ms;
  while (pending(node(ctx).chatUnconfirmed({ linkId: chat }))) {
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the contact has not confirmed the ${what} yet. It is kept here and ${goesOn(ctx)}`, { chat });
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
      settled = true; clearTimeout(timer); off();
      if (error) reject(error); else resolve(message!);
    };
    const check = (last = false) => void node(ctx).getMessage(chat, messageId).then((message) => {
      try {
        const done = look(message);
        if (done) finish(null, done);
        else if (last) finish(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the message is ${message?.delivery ?? "not sent yet"} and ${goesOn(ctx)}`, { messageId, delivery: message?.delivery ?? null }));
      } catch (error) { finish(error); }
    }, finish);
    const timer = setTimeout(() => check(true), ms);
    // Any event naming the message: a message first seen already delivered comes as `message.sent`, never as
    // `message.delivery`. Listening before the first read leaves no gap for a change to slip through.
    const off = ctx.hub.onEvent((event: GhostlyEvent) => {
      if (event.chat === chat && (event.messageId === messageId || (event.message as { id?: string } | undefined)?.id === messageId)) check();
    });
    check();
  });
}
