import type { GroupPayNote } from "@ghostly/browser/shared/types";
import type { Translate } from "../../contexts/I18nContext";
import { filePreview, previewText } from "../../lib/chatList";
import { servicesPlatform } from "../../lib/platform";
import { paymentLine, storedPaymentLine } from "../paymentWords";
import { appCardLine, cardLine, showsCard } from "../../lib/statusCards";
import type { Announceable } from "./MessageAnnouncer";

/** A message is read out up to this many characters. */
const PREVIEW_CHARS = 80;

/**
 * What a message says, read out: a status card's line, a payment's (paymentLine, as the chat list), a voice message's
 * or a video's (filePreview, as the chat list), else its text. An app card's line only where the chat's bubbles draw it
 * as a card (`appCards`: `appCardsShown`), its text elsewhere, as the bubble shows it. A group's payment note as its
 * timeline shows it (`noteLine`), not the engine's English line.
 */
export function spoken(message: Announceable, t: Translate, appCards: boolean, noteLine?: (note: GroupPayNote) => string | null): string {
  if (showsCard(message.card)) return cardLine(message.card);
  const note = message.groupPay && noteLine?.(message.groupPay);
  if (note) return note;
  const wallet = message.paymentId ? servicesPlatform?.wallet : undefined;
  const payment = wallet?.getPayment(message.paymentId!);
  if (payment) return paymentLine(t, payment, wallet!.getState());
  // A payment the wallet does not know (yet): its stored English line, said as the bubble says it.
  if (message.paymentId) return storedPaymentLine(t, message.text, message.sender === "me");
  return appCardLine(message.card, appCards, t) ?? filePreview(message.file, t) ?? previewText(message.text, t);
}

/** A line read out, on one line and up to `PREVIEW_CHARS`. */
export const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
};

/** A message as the chat's announcer reads it out, the start of it (MessageAnnouncer): the chat's search says its match so too. */
export const spokenShort = (message: Announceable, t: Translate, appCards: boolean, noteLine?: (note: GroupPayNote) => string | null) =>
  short(spoken(message, t, appCards, noteLine));
