import { decodeBolt11, isBitcoinAddress, type BitcoinNetwork, type Bolt11Invoice, type WalletNetwork } from "@ghostly/core";
import { cut, insideUrl, trimUriEnd, URI_MAX_CHARS } from "./money-text";

/**
 * The chain an address is for, as far as its prefix says. `tb1…` and the base58 test prefixes are shared by
 * testnet, signet and Mutinynet (and a base58 test address by regtest too), so `testnet` means "one of those".
 */
export type AddressChain = "bitcoin" | "testnet" | "regtest";

export interface OnchainRequest {
  address: string;
  chain: AddressChain;
  /** Real money or test coins: `bc1…`, `1…`, `3…` are real money; every other prefix is a test network. */
  network: WalletNetwork;
  /** BIP 21 `amount`, in whole sats. */
  amountSat?: number;
  label?: string;
  message?: string;
  /** BIP 21 `lightning=`: the same payment as a BOLT 11 invoice, for a wallet that pays Lightning. */
  lightning?: Bolt11Invoice;
  /** A `req-` parameter this app does not understand: BIP 21 says such a link must not be paid. */
  unsupported?: string[];
  /** The whole `bitcoin:` link, when the address came in one. */
  uri?: string;
}

/** Which chain an address is valid on (checksum, witness version, length), or null when it is none. */
export function addressChain(address: string): AddressChain | null {
  if (isBitcoinAddress(address, "bitcoin")) return "bitcoin";
  // Regtest first: `bcrt1…` is only regtest, and a base58 test address is testnet's as much as regtest's.
  if (/^bcrt1/i.test(address) && isBitcoinAddress(address, "regtest")) return "regtest";
  if (isBitcoinAddress(address, "testnet")) return "testnet";
  return null;
}

/** Whether a wallet on `walletChain` can pay an address of `chain`: `tb1…` works on testnet, signet and Mutinynet. */
export function chainAccepts(walletChain: string, address: string): boolean {
  return isBitcoinAddress(address, walletChain as BitcoinNetwork);
}

/** Words shaped like a Bitcoin address: bech32 (one case) and base58. The checksum decides. */
const SEGWIT_WORD = /(?<![A-Za-z0-9])(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:BC|TB|BCRT)1[02-9AC-HJ-NP-Z]{8,87}(?![A-Za-z0-9])/g;
const BASE58_WORD = /(?<![A-Za-z0-9])[123mn][1-9A-HJ-NP-Za-km-z]{25,34}(?![A-Za-z0-9])/g;

/** A bare address anywhere in a message, checksum-validated. */
export function findBitcoinAddress(text: string): { request: OnchainRequest; rest: string } | null {
  for (const pattern of [SEGWIT_WORD, BASE58_WORD]) {
    for (const match of text.matchAll(pattern)) {
      const chain = insideUrl(text, match.index!) ? null : addressChain(match[0]);
      if (!chain) continue;
      return { request: { address: match[0], chain, network: chain === "bitcoin" ? "mainnet" : "testnet" }, rest: cut(text, match.index!, match[0].length) };
    }
  }
  return null;
}

/** BIP 21 `amount`: decimal bitcoin, at most 8 decimals, no exponent. Whole sats, or null when it is not one. */
export function btcToSats(value: string): number | null {
  const match = /^(\d{1,8})(?:\.(\d{0,8}))?$/.exec(value) ?? /^()\.(\d{1,8})$/.exec(value);
  if (!match) return null;
  const sats = Number(match[1] || "0") * 100_000_000 + Number((match[2] ?? "").padEnd(8, "0"));
  return sats > 0 && sats <= 21_000_000 * 100_000_000 ? sats : null;
}

/** What a `bitcoin:` link carries, before this app picks what to show. */
export interface Bip21 {
  uri: string;
  address: string;
  params: Map<string, string>;
  index: number;
}

const BIP21 = /(?<![A-Za-z0-9])bitcoin:[^\s<>"'`]+/gi;

/** Every `bitcoin:` link in the text, parameters decoded (names lower-cased, the first of a repeated one kept). */
export function findBip21(text: string): Bip21[] {
  const found: Bip21[] = [];
  for (const match of text.matchAll(BIP21)) {
    if (match[0].length > URI_MAX_CHARS || insideUrl(text, match.index!)) continue;
    const uri = trimUriEnd(match[0]);
    const body = uri.slice("bitcoin:".length);
    const query = body.indexOf("?");
    const address = (query < 0 ? body : body.slice(0, query)).replace(/^\/\//, "");
    const params = new Map<string, string>();
    if (query >= 0) {
      for (const pair of body.slice(query + 1).split("&")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        const name = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
        let value = eq < 0 ? "" : pair.slice(eq + 1);
        try { value = decodeURIComponent(value.replace(/\+/g, "%20")); } catch { /* kept as written */ }
        if (!params.has(name)) params.set(name, value);
      }
    }
    found.push({ uri, address, params, index: match.index! });
  }
  return found;
}

/** Parameters this app reads; any other `req-` one makes the link one it must not pay (BIP 21). */
const KNOWN = new Set(["amount", "label", "message", "lightning", "lno", "ark"]);

/**
 * A `bitcoin:` link to an address: its amount, label, message and Lightning fallback. Null when the address is
 * missing or its checksum is wrong (a link carrying only `lightning=`, `lno=` or `ark=` is read by those parsers).
 */
export function onchainFromBip21(link: Bip21): OnchainRequest | null {
  const chain = link.address ? addressChain(link.address) : null;
  if (!chain) return null;
  const network: WalletNetwork = chain === "bitcoin" ? "mainnet" : "testnet";
  const request: OnchainRequest = { address: link.address, chain, network, uri: link.uri };
  const amount = link.params.get("amount");
  if (amount !== undefined) {
    const sats = btcToSats(amount);
    // An amount this cannot read is not guessed at: the link is shown, not paid.
    if (sats === null) request.unsupported = ["amount"];
    else request.amountSat = sats;
  }
  const label = link.params.get("label")?.trim(), message = link.params.get("message")?.trim();
  if (label) request.label = label.slice(0, 140);
  if (message) request.message = message.slice(0, 140);
  const invoice = link.params.get("lightning");
  const decoded = invoice ? decodeBolt11(invoice) : null;
  // A fallback on another network than the address is not the same payment: left out.
  if (decoded && (decoded.network === "bitcoin") === (network === "mainnet")) request.lightning = decoded;
  const unknown = [...link.params.keys()].filter((name) => name.startsWith("req-") && !KNOWN.has(name.slice(4)));
  if (unknown.length) request.unsupported = [...(request.unsupported ?? []), ...unknown];
  return request;
}
