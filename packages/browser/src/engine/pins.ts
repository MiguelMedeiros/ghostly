import { mayPin, nextPinNumber, type WirePin } from "@ghostly/core";
import { replyRef } from "../shared/replies";
import type { GroupView, PinView, StoredMessage, StoredPin } from "../shared/types";
import { reactionTarget } from "./reactions";

/*
 * A chat's pinned message (WISP 400 § Pinned message), as the engine keeps it: one per chat, on the link or the group,
 * the highest number winning. How it travels is the caller's: a 1:1 chat's session (`pin/1`), a private group's
 * signed frame over the edges, a community's sealed frame.
 */

export interface PinsHost {
  messages(chat: string): Promise<StoredMessage[]>;
  /** One row by its id (`db.getMessage`): a pin's row is looked for so first. */
  message?(chat: string, id: string): Promise<StoredMessage | undefined>;
}

const isGroup = (chat: string) => chat.startsWith("group:");

/** What the pages and the CLI see of a pin (`id` "" once unpinned, and by whom). */
export function pinView(pin: StoredPin | undefined): PinView | undefined {
  return pin && { id: pin.id, by: pin.by, at: pin.at, ...(pin.messageId && { messageId: pin.messageId }) };
}

/**
 * Whether a private group's pin was made by someone no longer in its roster (`inRoster`): it goes when they do, so a
 * member removed leaves nothing of theirs at the top of the chat.
 */
export function pinOfFormerMember(pin: StoredPin | undefined, inRoster: (key: string) => boolean): boolean {
  return !!pin && pin.by !== "me" && !inRoster(pin.by);
}

/** Whether I may pin in this group now: the rule (`mayPin`) with my key and its admin's. */
export function mayPinIn(group: GroupView | undefined): boolean {
  return !!group?.myKey && group.status === "active" && mayPin(group.profile, group.myKey, group.members.find(m => m.role === "admin")?.key);
}

/** The row a pin names, when it is here: the row of that id (a group's), or of `peer_`/`me_` and that id, or any other. */
export async function pinnedRow(host: PinsHost, chat: string, id: string): Promise<StoredMessage | undefined> {
  if (!id) return undefined;
  const group = isGroup(chat);
  if (host.message) {
    for (const rowId of group ? [id] : [`peer_${id}`, `me_${id}`]) {
      const row = await host.message(chat, rowId);
      if (row && replyRef(row, group) === id) return row;
    }
  }
  return reactionTarget(await host.messages(chat), id, group);
}

/**
 * This side's pin (`messageId` its row here or the id both sides know; `remove` unpins): numbered past the pin shown
 * now, or why it cannot be.
 */
export async function myPin(host: PinsHost, chat: string, messageId: unknown, remove: boolean, current: WirePin | undefined, now = Date.now()): Promise<StoredPin | { error: string }> {
  const n = nextPinNumber(current?.n, now);
  if (remove) return current?.id ? { id: "", n, by: "me", at: now } : { error: "Nothing is pinned in this chat" };
  if (typeof messageId !== "string" || !messageId) return { error: "No message to pin" };
  const group = isGroup(chat);
  const target = (await host.message?.(chat, messageId)) ?? (await host.messages(chat)).find(m => m.id === messageId) ?? await pinnedRow(host, chat, messageId);
  const id = target && replyRef(target, group);
  if (!target || !id) return { error: "That message is not in this chat, or cannot be pinned" };
  return { id, n, by: "me", at: now, messageId: target.id };
}
