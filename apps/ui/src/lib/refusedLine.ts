import { paymentRefusal } from "@ghostly/browser/shared/refusals";
import type { PaymentRefusedNotice } from "@ghostly/browser/shared/types";
import type { Translate } from "../locales/translate";
import { formatAmount } from "./amount";
import { problemLine } from "./problemText";

/**
 * A payment of the contact's this app refused, in the person's language: the amount in its unit (test sats on Testnet),
 * the reason the contact was told read through `problemLine`. The engine keeps the line in English as the row's text
 * (`shared/refusals.ts`); the timeline (MessageBubble) and the chat list's last line say it the same way.
 */
export function refusedLine(notice: PaymentRefusedNotice, t: Translate): string {
  const reason = problemLine(notice.reason, t);
  if (notice.amount === undefined) return t(notice.method === "fedimint" ? "chat.refused.fedimint" : "chat.refused.payment", { reason });
  const amount = formatAmount(notice.amount, t.language);
  const test = notice.network === "testnet";
  if (notice.method === "fedimint") {
    // A federation not known here (one not joined) says nothing of the network: the notes, not an amount in a unit.
    if (!notice.network) return t("chat.refused.fedimint", { reason });
    return t(test ? "chat.refused.testSatsFedimint" : "chat.refused.satsFedimint", { amount, reason });
  }
  return t(test ? "chat.refused.testSats" : "chat.refused.sats", { amount, reason });
}

/** The refusal line a chat row is, in the person's language; undefined when the row is not one. */
export function refusedRowText(row: { id: string; text: string; notice?: unknown }, t: Translate): string | undefined {
  const notice = paymentRefusal(row);
  return notice && refusedLine(notice, t);
}
