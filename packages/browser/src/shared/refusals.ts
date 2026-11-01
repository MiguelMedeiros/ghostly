import type { WalletNetwork } from "@ghostly/core";
import type { PaymentRefusedNotice } from "./types";

/*
 * The line a chat gets when this app refuses a contact's payment, or a redeem ends without the ecash
 * (`engine/payments.ts`): the app's own line, not a message of the contact's. The engine stores the values
 * (`StoredMessage.notice`) with the English below as `text`, which the CLI and apps from before the notice show; the UI
 * says it in its own language from the values. Lines stored before the notice existed are read back from that English.
 */

/** The ids the engine writes these lines under; a contact's message is stored as `peer_<number>`, never under one. */
const REFUSAL_ID = /^peer_(?:\d+_refused|spent_[0-9a-f]{32})$/;
/** The English `refusedText` writes, and every version before it wrote ("Could not receive 21 sats: …"). */
const REFUSAL_TEXT = /^Could not receive (?:(a payment)|(Fedimint ecash)|(\d[\d.,'\u00a0\u202f ]*) (test )?sats): ([\s\S]+)$/;
/** A reason longer than this is not one the engine wrote: it is cut, as a damaged copy must not fill a chat. */
const REASON_LIMIT = 500;

const NETWORKS: readonly WalletNetwork[] = ["mainnet", "testnet"];

/** The English line for `notice`, stored as the row's `text`. */
export function refusedText(notice: Omit<PaymentRefusedNotice, "type">): string {
  const what = notice.method === "fedimint" ? "Fedimint ecash"
    : notice.amount === undefined ? "a payment"
    : `${notice.amount.toLocaleString("en-US")} ${notice.network === "testnet" ? "test sats" : "sats"}`;
  return `Could not receive ${what}: ${notice.reason}`;
}

/** The row the engine stores for a refusal: the values, and their English as the text. */
export function refusedRow(notice: Omit<PaymentRefusedNotice, "type">): { text: string; notice: PaymentRefusedNotice } {
  const values: PaymentRefusedNotice = {
    type: "paymentRefused",
    ...(notice.amount !== undefined && { amount: notice.amount }),
    ...(notice.network && { network: notice.network }),
    ...(notice.method && { method: notice.method }),
    reason: notice.reason,
  };
  return { text: refusedText(values), notice: values };
}

const amountOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The refusal a chat row is, or undefined when it is not one: its stored values (anything invalid in them left out,
 * read as unknown), else the English an older version stored under the same ids. Only rows under the engine's
 * refusal ids count, so a contact who writes "Could not receive…" is shown as the message it is.
 */
export function paymentRefusal(row: { id: string; text: string; notice?: unknown }): PaymentRefusedNotice | undefined {
  if (!REFUSAL_ID.test(row.id)) return undefined;
  const stored = row.notice as Partial<Record<keyof PaymentRefusedNotice, unknown>> | undefined;
  if (stored && typeof stored === "object" && stored.type === "paymentRefused" && typeof stored.reason === "string" && stored.reason.trim()) {
    const amount = amountOf(stored.amount);
    const network = NETWORKS.find((n) => n === stored.network);
    return {
      type: "paymentRefused",
      ...(amount !== undefined && { amount }),
      ...(network && { network }),
      ...(stored.method === "fedimint" && { method: "fedimint" as const }),
      reason: stored.reason.slice(0, REASON_LIMIT),
    };
  }
  const line = REFUSAL_TEXT.exec(row.text);
  if (!line) return undefined;
  const [, , fedimint, written, test, reason] = line;
  // Written in whatever locale that engine ran in ("1,000", "1.000", "1 000"): only its digits.
  const amount = written === undefined ? undefined : amountOf(Number(written.replace(/\D/g, "")));
  return {
    type: "paymentRefused",
    ...(amount !== undefined && { amount }),
    // "test sats" was never written before the notice; "sats" then said nothing of the network.
    ...(test && { network: "testnet" as const }),
    ...(fedimint && { method: "fedimint" as const }),
    reason: reason!.slice(0, REASON_LIMIT),
  };
}
