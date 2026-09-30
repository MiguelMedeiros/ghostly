import type { ButtonsCard, CardButton } from "@ghostly/core";
import type { MessagePress, StoredMessage } from "./types";

/*
 * Message buttons (WISP 4xx · Message Buttons) as the engine and the UI both need them. A bot's message carries its
 * buttons as a card of kind `buttons` (`sc`); a press is a reply to it whose text is the button's label and whose `r`
 * names the button (`b`). Only the message's author learns of a press, from the reply: nothing else changes.
 */

/** The buttons of a message, when it has any. */
export function messageButtons(message: Pick<StoredMessage, "card">): ButtonsCard | undefined {
  return message.card?.kind === "buttons" ? message.card : undefined;
}

type Row = Pick<StoredMessage, "sender" | "member" | "replyTo" | "press" | "id">;

/**
 * Whether a reply's text is a button's label (or id): ignoring case and spaces at the ends. Not the device's locale's
 * case: the presser's and the author's apps must agree ("I" is not "ı" anywhere).
 */
export const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What a reply presses on the author's side, or nothing: the original is this side's own message with buttons still
 * open, the button is one of them (named by `b`, or, for a reply that lost it on the way (the DHT floor carries a
 * reply's id alone) or came from an app without buttons, a text that is a button's label or id), and the presser has
 * not already answered with a `once` button. A reply naming a button says its label: one whose text is something else
 * ("No" naming `yes`) is only a reply, so what the chat shows and what the author takes never differ. `history`: the chat's rows, the reply itself excluded or not.
 */
export function buttonPress(reply: Pick<StoredMessage, "sender" | "member" | "replyTo" | "text" | "id">, original: StoredMessage, history: readonly Row[]): MessagePress | undefined {
  if (reply.sender !== "peer" || original.sender !== "me" || !reply.replyTo) return undefined;
  const card = messageButtons(original);
  if (!card || card.closed) return undefined;
  const { button, inferred } = repliedButton(card, reply.text, reply.replyTo.button);
  if (!button) return undefined;
  if (answered(card, original.id, history.filter(row => row.id !== reply.id && row.sender === "peer" && row.member === reply.member))) return undefined;
  return { messageId: original.id, button: button.id, label: button.label, ...(inferred && { inferred: true as const }) };
}

/**
 * The button a reply to a question presses: the one `b` names when the text is its label, or, without `b`, the one
 * whose label or id the text is (`inferred`). The author's rule and the presser's own view both read replies so.
 */
function repliedButton(card: ButtonsCard, text: string, named: string | undefined): { button?: CardButton; inferred?: true } {
  if (named) return { button: card.buttons.find(b => b.id === named && sameLabel(b.label, text)) };
  const button = card.buttons.find(b => sameLabel(b.label, text) || sameLabel(b.id, text));
  return button ? { button, inferred: true } : {};
}

/** Whether these rows (one person's) already answered the question with a `once` button. */
function answered(card: ButtonsCard, messageId: string, rows: readonly Row[]): boolean {
  return rows.some(row => row.press?.messageId === messageId && !!card.buttons.find(b => b.id === row.press!.button)?.once);
}

/**
 * The buttons of a message as the reader's app shows them: which one this side pressed last (from its own replies),
 * and whether it may press again. Closed, or answered with a `once` button: no more presses. `chosen`: the bot's
 * answer when it said one, else this side's own last press. A reply typed in words that is a button's label or id
 * counts as its press, as the author's app takes it (`buttonPress`): "yes" answering a once question answers it here.
 */
export function buttonsState(message: Pick<StoredMessage, "id" | "card" | "sender">, ref: string | undefined, history: readonly Pick<StoredMessage, "sender" | "replyTo" | "timestamp" | "text">[]): { card: ButtonsCard; mine?: string; chosen?: string; open: boolean } | undefined {
  const card = messageButtons(message);
  if (!card) return undefined;
  let mine: string | undefined, last = -Infinity, locked = false;
  for (const row of history) {
    if (row.sender !== "me" || !row.replyTo) continue;
    if (row.replyTo.messageId !== message.id && (!ref || row.replyTo.id !== ref)) continue;
    const { button } = repliedButton(card, row.text, row.replyTo.button);
    if (!button) continue;
    if (button.once) locked = true;
    if (row.timestamp >= last) { last = row.timestamp; mine = button.id; }
  }
  const open = message.sender !== "me" && !card.closed && !locked;
  return { card, ...(mine && { mine }), ...((card.chosen ?? mine) && { chosen: card.chosen ?? mine }), open };
}
