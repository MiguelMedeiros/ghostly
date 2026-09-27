import { replySnippet, type WireReply } from "@ghostly/core";
import type { MessageReply, StoredMessage } from "./types";

/*
 * Replies (WISP 400 § Replies) as the engine and the UI both need them: which id a message goes by on both sides of
 * its chat, and a reply as it is kept and as it goes on the wire.
 */

/** A paired chat's text (`me_`/`peer_` + its 22-character wire id), or a held file (`peer_` + its 16-character one). */
const PAIRED_ROW = /^(?:me|peer)_([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{16})$/;
const WIRE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const GROUP_LINK = "group:";

/** The parts of a message, as the engine or the UI keeps it, that say which id both sides know it by. */
export interface ReplyTarget {
  id: string;
  linkId?: string;
  wireId?: string;
  paymentId?: string;
  file?: { id: string };
  event?: unknown;
  groupPay?: unknown;
  /** Set by the UI from the engine's row (`replyRef`), for what the UI's own copy no longer says. */
  ref?: string;
}

/**
 * The id a message of a chat goes by on both sides, which a reply names; none for what only this side has (a notice,
 * a group payment line, a refused payment). A paired chat: the text's wire id, a payment's id, a file's wire id. A
 * group: the message id, which is the same for every member.
 */
export function replyRef(message: ReplyTarget, group = message.linkId?.startsWith(GROUP_LINK) ?? false): string | undefined {
  if (message.ref) return message.ref;
  if (group) return message.paymentId || message.event || message.groupPay || !message.id.includes(":") ? undefined : message.id;
  if (message.paymentId) return message.paymentId;
  if (message.wireId && WIRE_ID.test(message.wireId)) return message.wireId;
  const out = message.file?.id.match(/-out-([A-Za-z0-9_-]{8,64})$/);
  if (out) return out[1];
  const row = message.id.match(PAIRED_ROW);
  return row && !/^\d+$/.test(row[1]) ? row[1] : undefined;
}

/** A reply to `original` as this side keeps it: always found, since it is here. */
export function replyTo(original: StoredMessage, ref: string): MessageReply {
  return { id: ref, snippet: replySnippet(original.text), from: original.sender === "me" ? "me" : "peer",
    ...(original.member && { member: original.member }), messageId: original.id };
}

/**
 * A reply as it goes on a paired chat's wire, from the side that sends it (`f`: who wrote the original, from the
 * sender's side). For a group, `f` is the author's member key, which the reply keeps.
 */
export function pairedWireReply(reply: MessageReply, sender: "me" | "peer" = "me"): WireReply {
  return { i: reply.id, s: reply.snippet, f: reply.from === sender ? "sender" : "recipient" };
}

/** A paired chat's reply as it arrived (`f` from the sender's side), as this side keeps it. */
export function receivedPairedReply(reply: WireReply | { i: string }): MessageReply {
  if (!("f" in reply)) return { id: reply.i, snippet: "" };
  return { id: reply.i, snippet: reply.s, from: reply.f === "sender" ? "peer" : "me" };
}

/** A group's reply as it arrived or was sent (`f` the author's member key), as this member keeps it. */
export function groupReply(reply: WireReply, myKey: string): MessageReply {
  return { id: reply.i, snippet: reply.s, from: reply.f === myKey ? "me" : "peer", member: reply.f };
}
