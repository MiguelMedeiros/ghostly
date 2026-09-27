import { utf8Encode, type LinkPreview } from "@ghostly/core";
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

/** A text of mine in a 1:1 chat that has gone or is going to the contact: not a file, a payment, a notice or a group line. */
export function canEdit(message: Pick<StoredMessage, "sender" | "linkId" | "wireId" | "file" | "paymentId" | "event" | "groupPay" | "text">): boolean {
  return message.sender === "me" && !!message.wireId && !message.linkId.startsWith("group:") && !message.file && !message.paymentId
    && !message.event && !message.groupPay && !JOIN_NOTICE.test(message.text);
}

/** A text of the contact's that an edit may change (the same kinds, from the other side). */
export function takesPeerEdit(message: Pick<StoredMessage, "sender" | "file" | "paymentId" | "event" | "groupPay" | "text">): boolean {
  return message.sender === "peer" && !message.file && !message.paymentId && !message.event && !message.groupPay && !JOIN_NOTICE.test(message.text);
}

/**
 * The message after edit `seq`, made at `at`: the new text (and the preview that came with it, or none), the version it
 * replaces kept in the history. A text that did not change adds no version.
 */
export function withEdit(message: StoredMessage, edit: { seq: number; at: number; text: string; preview?: LinkPreview; pending?: boolean }): StoredMessage {
  const before = message.edit?.history ?? [];
  const history = edit.text === message.text ? before : trimHistory([...before, { at: message.edit?.at ?? message.timestamp, text: message.text }]);
  const next: MessageEdit = { seq: edit.seq, at: edit.at, history, ...(edit.pending && { pending: true as const }) };
  const { preview: _old, ...rest } = message;
  return { ...rest, text: edit.text, edit: next, ...(edit.preview && { preview: edit.preview }) };
}

function trimHistory(history: MessageEdit["history"]): MessageEdit["history"] {
  let kept = history.slice(-EDIT_HISTORY_KEEP);
  while (kept.length > 1 && kept.reduce((sum, version) => sum + utf8Encode(version.text).length, 0) > EDIT_HISTORY_MAX_BYTES) kept = kept.slice(1);
  return kept;
}
