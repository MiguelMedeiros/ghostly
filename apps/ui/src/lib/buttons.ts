import { replySnippet, type StatusCard } from "@ghostly/core";
import { buttonsState } from "@ghostly/browser/shared/buttons";
import type { MessageReply, StoredMessage } from "@ghostly/browser/shared/types";

/*
 * Message buttons (WISP 4xx · Message Buttons) as a chat shows them: which one was chosen, and whether this side may
 * still press one. The engine's own rule (`buttonsState`), over the chat's rows as the page holds them.
 */

export type ButtonsView = NonNullable<ReturnType<typeof buttonsState>>;

/** What the rule needs of a row: a 1:1 chat's `ChatMessage` and a group's `StoredMessage` both have it. */
export interface ButtonsRow { id: string; sender: string; timestamp: number; card?: StatusCard; replyTo?: MessageReply }

/**
 * The buttons of every message of these rows that has some, by the message's id. `refOf`: the id a reply to a row
 * names (`ChatMessage.ref` in a 1:1 chat, `replyRef(m, true)` in a group).
 */
export function buttonsViews<R extends ButtonsRow>(rows: readonly R[], refOf: (row: R) => string | undefined): Map<string, ButtonsView> {
  const views = new Map<string, ButtonsView>();
  const history = rows as unknown as readonly Pick<StoredMessage, "sender" | "replyTo" | "timestamp">[];
  for (const row of rows) {
    if (row.card?.kind !== "buttons") continue;
    const view = buttonsState(row as unknown as Pick<StoredMessage, "id" | "card" | "sender">, refOf(row), history);
    if (view) views.set(row.id, view);
  }
  return views;
}

/**
 * The replies of these rows drawn as a compact press ("↩ Yes", not a quote): each names a button its question (a message
 * of these rows with buttons) has, and quotes the question as it reads now. A question whose text changed after the
 * press, or a `b` naming no button of it, leaves the reply a reply, its quote shown.
 */
export function compactPresses<R extends ButtonsRow & { text: string; file?: unknown; paymentId?: string }>(rows: readonly R[], refOf: (row: R) => string | undefined): Set<string> {
  const compact = new Set<string>();
  for (const row of rows) {
    const reply = row.replyTo;
    if (!reply?.button || !isButtonPress(row)) continue;
    const question = rows.find(r => r.id === reply.messageId) ?? rows.find(r => r !== row && refOf(r) === reply.id);
    if (question?.card?.kind !== "buttons" || !question.card.buttons.some(b => b.id === reply.button)) continue;
    if (replySnippet(question.text) === reply.snippet) compact.add(row.id);
  }
  return compact;
}

/** A reply that is a button press: it shows as "↩ Yes", linked to the question, not as a quote. */
export function isButtonPress(message: { replyTo?: MessageReply; file?: unknown; paymentId?: string }): boolean {
  return !!message.replyTo?.button && !message.file && !message.paymentId;
}
