import { replySnippet, type StatusCard } from "@ghostly/core";
import { buttonsState, sameLabel } from "@ghostly/browser/shared/buttons";
import type { MessageReply, StoredMessage } from "@ghostly/browser/shared/types";

/*
 * Message buttons (WISP 406 · Message Buttons) as a chat shows them: which one was chosen, and whether this side may
 * still press one. The engine's own rule (`buttonsState`), over the chat's rows as the page holds them.
 */

export type ButtonsView = NonNullable<ReturnType<typeof buttonsState>>;

/** What the rule needs of a row: a 1:1 chat's `ChatMessage` and a group's `StoredMessage` both have it. */
export interface ButtonsRow { id: string; sender: string; timestamp: number; text: string; card?: StatusCard; replyTo?: MessageReply }

/**
 * The buttons of every message of these rows that has some, by the message's id. `refOf`: the id a reply to a row
 * names (`ChatMessage.ref` in a 1:1 chat, `replyRef(m, true)` in a group).
 */
export function buttonsViews<R extends ButtonsRow>(rows: readonly R[], refOf: (row: R) => string | undefined): Map<string, ButtonsView> {
  const views = new Map<string, ButtonsView>();
  // My replies by the message they name, read once: each question reads its own, not the whole history. Read per
  // question, a 5,000-message bot chat with one every 5 froze the page for 88 ms per arrival (334 ms at 4x CPU, agents#1703).
  const byMessage = new Map<string | undefined, number[]>(), byRef = new Map<string, number[]>();
  const add = <K>(index: Map<K, number[]>, key: K, at: number) => { const list = index.get(key); if (list) list.push(at); else index.set(key, [at]); };
  rows.forEach((row, at) => {
    if (row.sender !== "me" || !row.replyTo) return;
    add(byMessage, row.replyTo.messageId, at);
    if (row.replyTo.id) add(byRef, row.replyTo.id, at);
  });
  for (const row of rows) {
    if (row.card?.kind !== "buttons") continue;
    const ref = refOf(row);
    // In the history's order, each once: `buttonsState` takes the last of equal times.
    const at = [...new Set([...byMessage.get(row.id) ?? [], ...(ref ? byRef.get(ref) ?? [] : [])])].sort((a, b) => a - b);
    const replies = at.map(i => rows[i]!) as unknown as readonly Pick<StoredMessage, "sender" | "replyTo" | "timestamp" | "text">[];
    const view = buttonsState(row as unknown as Pick<StoredMessage, "id" | "card" | "sender">, ref, replies);
    if (view) views.set(row.id, view);
  }
  return views;
}

/**
 * The replies of these rows drawn as a compact press ("↩ Yes", not a quote): each names a button its question (a message
 * of these rows with buttons) has, its text that button's label, and quotes the question as it reads now. A question
 * whose text changed after the press, a `b` naming no button of it, or a text that is not its label ("No" naming
 * `yes`), leaves the reply a reply, its quote shown.
 */
export function compactPresses<R extends ButtonsRow & { file?: unknown; paymentId?: string }>(rows: readonly R[], refOf: (row: R) => string | undefined): Set<string> {
  const compact = new Set<string>();
  // The rows by id and by the id a reply names, read once only when a press is there; the first of each, as `find` took.
  let byId: Map<string, R> | undefined, byRef: Map<string | undefined, R[]> | undefined;
  const index = () => {
    byId = new Map(); byRef = new Map();
    for (const r of rows) {
      if (!byId.has(r.id)) byId.set(r.id, r);
      const ref = refOf(r), list = byRef.get(ref) ?? [];
      // Two kept: the press itself may be the first.
      if (list.length < 2) { list.push(r); byRef.set(ref, list); }
    }
  };
  for (const row of rows) {
    const reply = row.replyTo;
    if (!reply?.button || !isButtonPress(row)) continue;
    if (!byId) index();
    const question = (reply.messageId === undefined ? undefined : byId!.get(reply.messageId)) ?? byRef!.get(reply.id)?.find(r => r !== row);
    if (question?.card?.kind !== "buttons" || !question.card.buttons.some(b => b.id === reply.button && sameLabel(b.label, row.text))) continue;
    if (replySnippet(question.text) === reply.snippet) compact.add(row.id);
  }
  return compact;
}

/** A reply that is a button press: it shows as "↩ Yes", linked to the question, not as a quote. */
export function isButtonPress(message: { replyTo?: MessageReply; file?: unknown; paymentId?: string }): boolean {
  return !!message.replyTo?.button && !message.file && !message.paymentId;
}
