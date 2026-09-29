import { utf8Encode, type LinkPreview, type StatusCard } from "@ghostly/core";
import type { MessageEdit, StoredMessage } from "./types";

/*
 * Edits (WISP 400 § Edits) as the engine and the UI both need them: which messages can be edited, and a message after
 * an edit, with the version it replaces kept in its history.
 */

/** Earlier versions a message keeps: the newest ones, within `EDIT_HISTORY_MAX_BYTES` of text. */
export const EDIT_HISTORY_KEEP = 20;
export const EDIT_HISTORY_MAX_BYTES = 64 * 1024;

/** The notice an app sends when a chat first goes live (useChat): shown as a line, never edited. */
const JOIN_NOTICE = /^👋 (?:.+ )?joined$/;

/** Whether a text reads as a join notice: the chat shows it as a line and takes the contact's name from it. */
export function isJoinNotice(text: string): boolean {
  return JOIN_NOTICE.test(text);
}

/** A text of mine in a 1:1 chat that has gone or is going to the contact: not a file, a payment, a notice or a group line. */
export function canEdit(message: Pick<StoredMessage, "sender" | "linkId" | "wireId" | "file" | "paymentId" | "event" | "groupPay" | "text">): boolean {
  return message.sender === "me" && !!message.wireId && !message.linkId.startsWith("group:") && !message.file && !message.paymentId
    && !message.event && !message.groupPay && !JOIN_NOTICE.test(message.text);
}

/** A group message's id: `<sender>:<epoch>:<seq>` in a private group, `<sender>:<epoch>:<commit>:<seq>` in a community. */
const GROUP_MESSAGE_ID = /^[a-z0-9]{52}:\d+:(?:[0-9a-f]{16}:)?\d+$/;

/** A text of mine in a group (WISP 9xx § Edits): one the group carried under its id, not a payment, a note or an event line. */
export function canEditInGroup(message: Pick<StoredMessage, "sender" | "linkId" | "id" | "file" | "paymentId" | "event" | "groupPay">): boolean {
  return message.sender === "me" && message.linkId.startsWith("group:") && GROUP_MESSAGE_ID.test(message.id) && !message.file && !message.paymentId
    && !message.event && !message.groupPay;
}

/**
 * A text of the contact's that an edit may change (the same kinds, from the other side), into `text` when it is given:
 * never into a join notice, which would read as a line of the chat's and rename the contact.
 */
export function takesPeerEdit(message: Pick<StoredMessage, "sender" | "file" | "paymentId" | "event" | "groupPay" | "text">, text?: string): boolean {
  return message.sender === "peer" && !message.file && !message.paymentId && !message.event && !message.groupPay && !JOIN_NOTICE.test(message.text)
    && (text === undefined || !JOIN_NOTICE.test(text));
}

/**
 * The message after edit `seq`, made at `at`: the new text (and the preview and the status card that came with it, or
 * none: each belongs to its version), the version it replaces kept in the history. A text that did not change adds no
 * version: a card's update often keeps its text.
 */
export function withEdit(message: StoredMessage, edit: { seq: number; at: number; text: string; preview?: LinkPreview; card?: StatusCard; pending?: boolean }): StoredMessage {
  const before = message.edit?.history ?? [];
  const history = edit.text === message.text ? before : trimHistory([...before, { at: message.edit?.at ?? message.timestamp, text: message.text }]);
  const next: MessageEdit = { seq: edit.seq, at: edit.at, history, ...(edit.pending && { pending: true as const }) };
  const { preview: _old, card: _card, ...rest } = message;
  return { ...rest, text: edit.text, edit: next, ...(edit.preview && { preview: edit.preview }), ...(edit.card && { card: edit.card }) };
}

function trimHistory(history: MessageEdit["history"]): MessageEdit["history"] {
  let kept = history.slice(-EDIT_HISTORY_KEEP);
  while (kept.length > 1 && kept.reduce((sum, version) => sum + utf8Encode(version.text).length, 0) > EDIT_HISTORY_MAX_BYTES) kept = kept.slice(1);
  return kept;
}
