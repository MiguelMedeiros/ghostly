import { decodeBolt11, parseLightningDestination, type Bolt11Invoice, type WalletNetwork } from "@ghostly/core";
import { decodeArkAddress } from "./parse/money-ark";
import { chainAccepts } from "./parse/money-bitcoin";
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
  /** A `bitcoin:` link that must not be paid (BIP 21: a `req-` parameter this app does not understand, an amount it cannot read). */
  | { kind: "refused" }
  | { kind: "unknown" };

const TOKEN = /^cashu[AB]/i;
// The URI schemes a token is shared behind, in the order the engine's cashu-ts strips them (lower case only: a token's
// base64 does not survive an upper-cased QR anyway).
const TOKEN_SCHEMES = ["web+cashu://", "cashu://", "cashu:"];

// The text as the wallet is given it: no `lightning:` scheme, in lower case (a QR's text is often upper case).
const invoiceRoute = (invoice: Bolt11Invoice): SendRoute =>
  invoice.amountSat === null ? { kind: "no-amount", text: invoice.invoice, invoice } : { kind: "invoice", text: invoice.invoice, invoice };

export function routeSend(input: string): SendRoute {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const scheme = TOKEN_SCHEMES.find((prefix) => text.startsWith(prefix));
  const token = scheme ? text.slice(scheme.length) : text;
  if (TOKEN.test(token)) return { kind: "token", text: token };
  // A BIP 21 link pays here only by its Lightning leg (the on-chain address is another card's), and only as the chat
  // reads the same link (`findLinkMoney`): never one that must not be paid, nor a fallback that is not the same payment
  // as its link (another amount, another network).
  if (/^bitcoin:/i.test(text)) {
    const money = findLinkMoney(text);
    if (money === "refused" || (money?.type === "onchain" && money.request.unsupported?.length)) return { kind: "refused" };
    const leg = money?.type === "onchain" ? money.request.lightning : money?.type === "lightning" ? money.invoice : undefined;
    return leg ? invoiceRoute(leg) : { kind: "unknown" };
  }
  const invoice = decodeBolt11(text);
  if (invoice) return invoiceRoute(invoice);
  try {
    const destination = parseLightningDestination(text);
    return destination ? { kind: "destination", text: destination.text } : { kind: "unknown" };
  } catch (error) {
    return { kind: "bad-destination", error };
  }
}

/** What the Bitcoin card's Send was given: an address on its chain, with the amount its link names. Nothing is paid here. */
export type BitcoinSendRoute =
  | { kind: "address"; address: string; amountSat?: number }
  /** A `bitcoin:` link that must not be paid (BIP 21: a `req-` parameter this app does not understand, an amount it cannot read). */
  | { kind: "refused" }
  | { kind: "unknown" };

export function routeBitcoinSend(input: string, chain: string): BitcoinSendRoute {
  const text = input.trim();
  if (/^bitcoin:/i.test(text)) {
    const money = findLinkMoney(text);
    if (money === "refused" || (money?.type === "onchain" && money.request.unsupported?.length)) return { kind: "refused" };
    if (money?.type !== "onchain" || !chainAccepts(chain, money.request.address)) return { kind: "unknown" };
    const { address, amountSat } = money.request;
    return amountSat === undefined ? { kind: "address", address } : { kind: "address", address, amountSat };
  }
  return chainAccepts(chain, text) ? { kind: "address", address: text } : { kind: "unknown" };
}

/** What an Ark card's Send was given: an address of its own Ark and network, with the amount its link names. */
export type ArkSendRoute = BitcoinSendRoute;

/** The two Arks never pay each other, and neither pays across networks: another's address is not this card's. */
export function routeArkSend(input: string, kind: "arkade" | "bark", network: WalletNetwork): ArkSendRoute {
  const text = input.trim();
  if (/^bitcoin:/i.test(text)) {
    const money = findLinkMoney(text);
    if (money === "refused") return { kind: "refused" };
    if (money?.type !== "ark" || money.request.kind !== kind || money.request.network !== network) return { kind: "unknown" };
    const { address, amountSat } = money.request;
    return amountSat === undefined ? { kind: "address", address } : { kind: "address", address, amountSat };
  }
  const decoded = decodeArkAddress(text);
  return decoded?.kind === kind && decoded.network === network ? { kind: "address", address: text.toLowerCase() } : { kind: "unknown" };
}
