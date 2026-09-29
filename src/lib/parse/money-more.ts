import { decodeBolt11, type Bolt11Invoice } from "@ghostly/core";
import { findArkAddress, type ArkRequest } from "./money-ark";
import { findBip21, findBitcoinAddress, onchainFromBip21, type OnchainRequest } from "./money-bitcoin";
import { decodeBolt12Offer, findBolt12Offer, type Bolt12Offer } from "./money-bolt12";
import { cut } from "./money-text";
import { findUsdtAddress, type UsdtRequest } from "./money-usdt";

/** The money formats beyond Lightning invoices, ecash and LNURL: each has its own card (MoneyFormatsBubble). */
export type MoreMoney =
  | { type: "onchain"; request: OnchainRequest; rest: string }
  | { type: "bolt12"; offer: Bolt12Offer; rest: string }
  | { type: "ark"; request: ArkRequest; rest: string }
  | { type: "usdt"; request: UsdtRequest; rest: string };

/**
 * A `bitcoin:` link, read before anything inside it: its address wins over the Lightning invoice it may carry
 * (which the card offers as the other way to pay). A link with no address is what its `lightning=`, `lno=` or
 * `ark=` says. Null when there is no `bitcoin:` link this can read.
 */
export function findLinkMoney(text: string): MoreMoney | { type: "lightning"; invoice: Bolt11Invoice; rest: string } | null {
  for (const link of findBip21(text)) {
    const onchain = onchainFromBip21(link);
    if (onchain) return { type: "onchain", request: onchain, rest: cut(text, link.index, link.uri.length) };
    if (link.address) continue;
    const offer = link.params.get("lno");
    const decodedOffer = offer ? decodeBolt12Offer(offer) : null;
    if (decodedOffer) return { type: "bolt12", offer: decodedOffer, rest: cut(text, link.index, link.uri.length) };
    const ark = link.params.has("ark") ? findArkAddress(link.uri) : null;
    if (ark) return { type: "ark", request: ark.request, rest: cut(text, link.index, link.uri.length) };
    const invoice = link.params.get("lightning");
    const decoded = invoice ? decodeBolt11(invoice) : null;
    if (decoded) return { type: "lightning", invoice: decoded, rest: cut(text, link.index, link.uri.length) };
  }
  return null;
}

/**
 * The formats read after invoices, ecash and LNURL: a BOLT 12 offer, an Ark address, a bare Bitcoin address
 * (checksum-validated), a USDT address (an `ethereum:` link, or `0x…` with USDT named).
 */
export function findMoreMoney(text: string): MoreMoney | null {
  const offer = findBolt12Offer(text);
  if (offer) return { type: "bolt12", ...offer };
  const ark = findArkAddress(text);
  if (ark) return { type: "ark", ...ark };
  const onchain = findBitcoinAddress(text);
  if (onchain) return { type: "onchain", ...onchain };
  const usdt = findUsdtAddress(text);
  if (usdt) return { type: "usdt", ...usdt };
  return null;
}

/** The chat's switch for each format: the way of paying that pays it. */
export function moreMoneyMethod(money: MoreMoney): "bitcoin" | "lightning" | "arkade" | "bark" | "usdt" {
  return money.type === "onchain" ? "bitcoin" : money.type === "bolt12" ? "lightning" : money.type === "ark" ? money.request.kind : "usdt";
}
