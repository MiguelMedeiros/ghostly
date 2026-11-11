import { paymentWireId } from "./paymentIds";
import type { GroupPayNote, PaymentView, StoredMessage } from "./types";

/** The id of a group payment note's line in the group's history (WISP 902 § Payments). */
export const groupPayLineId = (noteId: string): string => `gpay:${noteId}`;

type PaymentOf = Pick<PaymentView, "kind" | "requestId"> | undefined;
type PaymentRow = Pick<StoredMessage, "paymentId" | "sender" | "member">;

/** The group note a payment of this device is part of: a request's own, or the request a payment answers (by its id on the wire). */
export function groupPayNoteId(paymentId: string, payment: PaymentOf): string {
  return paymentWireId(payment?.kind === "payment" && payment.requestId ? payment.requestId : paymentId);
}

/**
 * The note that captions a payment bubble: the one about that bubble's own payment, which the member who started it
 * says (the payee of a request, the payer of a payment), never a note of another member that reuses its id.
 */
export function groupPayCaption(message: PaymentRow, payment: PaymentOf, noteOf: (id: string) => GroupPayNote | undefined, myKey: string | undefined): GroupPayNote | undefined {
  if (!message.paymentId) return undefined;
  // Said once, under the request (or the payment) itself: not again under a payment that answers it.
  if (payment?.kind === "payment" && payment.requestId) return undefined;
  const note = noteOf(groupPayNoteId(message.paymentId, payment));
  const starter = message.sender === "me" ? myKey : message.member;
  return note && starter && (note.kind === "request" ? note.to : note.from) === starter ? note : undefined;
}

/**
 * The note a payment bubble of this device says again (its own caption, or a payment answering it), by the note's id:
 * the group page draws the bubble and leaves that note's own line out, so the same payment shows once. Undefined for
 * a bubble no note of the group is about.
 */
export function groupPayTwin(message: PaymentRow, payment: PaymentOf, noteOf: (id: string) => GroupPayNote | undefined, myKey: string | undefined): string | undefined {
  if (!message.paymentId) return undefined;
  if (!groupPayCaption(message, payment, noteOf, myKey) && !payment?.requestId) return undefined;
  return groupPayNoteId(message.paymentId, payment);
}
