import type { StoredMessage } from "@ghostly/browser/shared/types";
import { node, type ApiContext } from "./apiKit";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";

/*
 * Waiting on what a command sent (WISP 1100): a message's delivery, an edit's confirmation, a group frame taken by an
 * edge. Shared by the chat, group and status card methods.
 */

const DELIVERY_RANK: Record<string, number> = { sending: 0, waiting: 1, queued: 1, held: 2, sent: 2, delivered: 3 };

/** Waits until the contact confirmed the latest edit of one of my messages (it is no longer pending). */
export async function waitForEdit(ctx: ApiContext, chat: string, messageId: string, ms: number): Promise<StoredMessage> {
  const until = Date.now() + ms;
  for (;;) {
    const message = (await node(ctx).getMessages(chat)).find((m) => m.id === messageId);
    if (!message) throw new CliError("not_found", `No message ${messageId} in this chat`);
    if (!message.edit?.pending) return message;
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the contact has not confirmed the edit yet. It goes by itself once the chat is live and the contact's app shows edits, while this profile is online`, { messageId, edits: message.edit.seq });
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
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: no member's edge took it yet. It stays in the group and goes when one opens, while this profile is online`, { messageId, ...(edit ? { edits: edit } : {}) });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Waits until a message of mine reached `target` (`sent`: on its way to the contact; `delivered`: acknowledged). */
export async function waitForMessage(ctx: ApiContext, chat: string, messageId: string, target: "sent" | "delivered", ms: number): Promise<StoredMessage> {
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
    const check = (last = false) => void node(ctx).getMessages(chat).then((messages) => {
      const message = messages.find((m) => m.id === messageId);
      try {
        const done = look(message);
        if (done) finish(null, done);
        else if (last) finish(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the message is ${message?.delivery ?? "not sent yet"} and still goes by itself while this profile is online`, { messageId, delivery: message?.delivery ?? null }));
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
