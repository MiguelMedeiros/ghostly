import { decodeBolt11, parseLightningDestination, type Bolt11Invoice } from "@ghostly/core";
import { findBip21 } from "./parse/money-bitcoin";

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
  | { kind: "unknown" };

const TOKEN = /^cashu[AB]/i;

export function routeSend(input: string): SendRoute {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  if (TOKEN.test(text)) return { kind: "token", text };
  // A BIP 21 link pays here only by its Lightning leg: the on-chain address is another card's.
  const link = /^bitcoin:/i.test(text) ? findBip21(text)[0] : undefined;
  const candidate = link ? link.params.get("lightning")?.trim() ?? "" : text;
  if (!candidate) return { kind: "unknown" };
  const invoice = decodeBolt11(candidate);
  if (invoice) {
    // The text as the wallet is given it: no `lightning:` scheme, in lower case (a QR's text is often upper case).
    return invoice.amountSat === null ? { kind: "no-amount", text: invoice.invoice, invoice } : { kind: "invoice", text: invoice.invoice, invoice };
  }
  if (link) return { kind: "unknown" };
  try {
    const destination = parseLightningDestination(candidate);
    return destination ? { kind: "destination", text: destination.text } : { kind: "unknown" };
  } catch (error) {
    return { kind: "bad-destination", error };
  }
}
