import { decodeBolt11, parseLightningDestination, type Bolt11Invoice } from "@ghostly/core";
import { findLinkMoney } from "./parse/money-more";

/**
 * What the Lightning and Cashu cards' Send was given (typed, pasted, scanned or read from a picture), sorted into what
 * they can pay: a BOLT 11 invoice (also a BIP 21 link's `lightning=`), a Lightning address or an LNURL-pay, or an ecash
 * token to redeem. Nothing is fetched or paid here.
 */
export type SendRoute =
  | { kind: "empty" }
  | { kind: "token"; text: string }
  | { kind: "invoice"; text: string; invoice: Bolt11Invoice }
  /** An invoice with no amount: the payer would have to choose one, which the cards cannot pay yet. */
  | { kind: "no-amount"; text: string; invoice: Bolt11Invoice }
  | { kind: "destination"; text: string }
  /** A Lightning address or LNURL, but one that must not be asked (plain HTTP, credentials, too long): the reason. */
  | { kind: "bad-destination"; error: unknown }
  /** A `bitcoin:` link that must not be paid (BIP 21: a `req-` parameter this app does not understand, or an amount it cannot read). */
  | { kind: "refused" }
  | { kind: "unknown" };

const TOKEN = /^cashu[AB]/i;

export function routeSend(input: string): SendRoute {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  if (TOKEN.test(text)) return { kind: "token", text };
  if (/^bitcoin:/i.test(text)) return linkRoute(text);
  const invoice = decodeBolt11(text);
  if (invoice) return invoiceRoute(invoice);
  try {
    const destination = parseLightningDestination(text);
    return destination ? { kind: "destination", text: destination.text } : { kind: "unknown" };
  } catch (error) {
    return { kind: "bad-destination", error };
  }
}

/**
 * A BIP 21 link pays here only by its Lightning leg (the on-chain address is another card's), read by the chat's rules:
 * the leg is kept only when it is the same payment as the link (same amount and network), and a link that must not be
 * paid is refused, Lightning leg and all.
 */
function linkRoute(text: string): SendRoute {
  const money = findLinkMoney(text);
  if (money === "refused") return { kind: "refused" };
  if (money?.type === "lightning") return invoiceRoute(money.invoice);
  if (money?.type !== "onchain") return { kind: "unknown" };
  if (money.request.unsupported) return { kind: "refused" };
  return money.request.lightning ? invoiceRoute(money.request.lightning) : { kind: "unknown" };
}

/** The text as the wallet is given it: no `lightning:` scheme, in lower case (a QR's text is often upper case). */
function invoiceRoute(invoice: Bolt11Invoice): SendRoute {
  return invoice.amountSat === null ? { kind: "no-amount", text: invoice.invoice, invoice } : { kind: "invoice", text: invoice.invoice, invoice };
}
