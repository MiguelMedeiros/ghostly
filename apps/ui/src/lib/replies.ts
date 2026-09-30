import { replySnippet, type StatusCard } from "@ghostly/core";
import { replyRef, replyTo, type ReplyTarget } from "@ghostly/browser/shared/replies";
import type { MessageReply } from "@ghostly/browser/shared/types";
import { revealMessage } from "../hooks/useRowWindow";
import { cardLine, showsCard } from "./statusCards";
import type { ChatMessage } from "./types";

/*
 * Replies in the chat's view (WISP 400 § Replies): which message a reply's quote stands for, and how it reads.
 */

/**
 * - `found`: the original is in this chat; the quote shows it as it is here, and a tap goes to it.
 * - `deleted`: it was here when the reply came, and is gone.
 * - `unverified`: it is not here; the line is only what the replier's app said.
 * - `missing`: it is not here, and nothing came with the reply but its id (a reply over the DHT).
 */
export type QuoteState = "found" | "deleted" | "unverified" | "missing";

export interface QuoteView {
  state: QuoteState;
  /** Who wrote the original, as this chat names them; absent when nothing says. */
  name?: string;
  /** A line of it; empty when there is none to show. */
  snippet: string;
  /** Mine: the quote takes my colour. */
  mine: boolean;
  /** A group member's original, not mine: its author's key, whose colour the name takes (lib/memberColors.ts). */
  member?: string;
  /** The original's row, to scroll to. */
  targetId?: string;
}

/** What a quote needs of a message: the UI's copy of a paired chat's, or a group's row as the engine keeps it. */
export type Quotable = ReplyTarget & { sender: string; text: string; member?: string; card?: StatusCard };

/** A message's line where it is quoted or pinned: its text's, or a bot's card's title (the text is only its fallback). */
export function messageSnippet(message: { text: string; card?: StatusCard }): string {
  return showsCard(message.card) ? replySnippet(cardLine(message.card)) : replySnippet(message.text);
}

/** A chat's messages by their id here and by the id a reply names (`replyRef`). */
export interface ReplyIndex { byId: Map<string, Quotable>; byRef: Map<string, Quotable> }

export function replyIndex(messages: readonly Quotable[], group = false): ReplyIndex {
  const byId = new Map<string, Quotable>(), byRef = new Map<string, Quotable>();
  for (const message of messages) {
    byId.set(message.id, message);
    const ref = replyRef(message, group);
    if (ref && !byRef.has(ref)) byRef.set(ref, message);
  }
  return { byId, byRef };
}

/** The id a reply to this message names; none when it cannot be replied to (a notice, a group payment line). */
export function replyTarget(message: Quotable & Pick<ChatMessage, "systemEvent" | "callEvent">, group = false): string | undefined {
  if (message.sender === "system" || message.systemEvent || message.callEvent) return undefined;
  return replyRef(message, group);
}

/**
 * A reply to `original` as the sender's own copy of a file keeps it, the way the engine keeps a reply sent here
 * (`replyTo` in shared/replies): found, since it is here. None when it cannot be replied to.
 */
export function sentReply(original: Quotable, group = false): MessageReply | undefined {
  const ref = replyRef(original, group);
  return ref ? replyTo(original, ref) : undefined;
}

/** Who wrote a message or an original, as the page names people: me, the contact, a member. */
export type NameOf = (from: "me" | "peer" | undefined, member?: string) => string | undefined;

/** The quote a reply shows. The original found here wins over what the wire said about it. */
export function quoteFor(reply: MessageReply, index: ReplyIndex, nameOf: NameOf): QuoteView {
  const original = (reply.messageId ? index.byId.get(reply.messageId) : undefined) ?? index.byRef.get(reply.id);
  if (original) {
    const from = original.sender === "me" ? "me" : "peer";
    const member = from === "peer" ? original.member ?? reply.member : undefined;
    return { state: "found", name: nameOf(from, original.member ?? reply.member), snippet: messageSnippet(original), mine: from === "me", targetId: original.id, ...(member && { member }) };
  }
  const name = reply.from ? nameOf(reply.from, reply.member) : undefined;
  const state: QuoteState = reply.messageId ? "deleted" : reply.snippet ? "unverified" : "missing";
  const member = reply.from === "peer" ? reply.member : undefined;
  return { state, name, snippet: state === "unverified" ? reply.snippet : "", mine: reply.from === "me", ...(member && { member }) };
}

/** How long a message a quote jumped to stays marked. */
export const REPLY_FLASH_MS = 1600;

/** Fired on a row just before a jump scrolls to it, for the list to follow it there (useChatScroll). */
export const JUMP_EVENT = "ghostly:jump-to-message";

/**
 * Scrolls a message into the middle of the chat and marks it for a moment (`data-reply-flash`). False when it is not
 * in the page (a history never holds more than what is loaded, which is all of it).
 */
export function jumpToMessage(id: string, root: ParentNode = document): boolean {
  const row = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(el => el.dataset.messageId === id);
  if (!row) return false;
  row.dispatchEvent(new Event(JUMP_EVENT, { bubbles: true }));
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Far away (a search's match a thousand messages up), at once: a smooth scroll that long takes seconds.
  const far = Math.abs(row.getBoundingClientRect().top) > 3 * window.innerHeight;
  row.scrollIntoView?.({ block: "center", behavior: reduce || far ? "auto" : "smooth" });
  row.removeAttribute("data-reply-flash");
  // A second jump while it is still marked starts the mark again.
  void row.offsetWidth;
  row.setAttribute("data-reply-flash", "");
  const timer = Number(row.dataset.replyFlashTimer);
  if (timer) clearTimeout(timer);
  row.dataset.replyFlashTimer = String(setTimeout(() => { row.removeAttribute("data-reply-flash"); delete row.dataset.replyFlashTimer; }, REPLY_FLASH_MS));
  return true;
}

/**
 * Goes to the message a reply answers. Not in the page (a long chat has a window of its rows, useRowWindow): the rows
 * around it first, and again. False when it is not in this chat.
 */
export function jumpToQuoted(targetId: string | undefined): boolean {
  return !!targetId && (jumpToMessage(targetId) || (revealMessage(targetId) && jumpToMessage(targetId)));
}
