import { bech32 } from "@scure/base";
import type { WalletNetwork } from "@ghostly/core";
import { cut, insideUrl, trimUriEnd } from "./money-text";

/** A BOLT 12 offer: a reusable Lightning payment code, read from its TLV fields (nothing is fetched). */
export interface Bolt12Offer {
  offer: string;
  /** The chains it is for: Bitcoin when it names none. `testnet` covers testnet, signet and regtest. */
  network: WalletNetwork;
  chain: "bitcoin" | "testnet" | "signet" | "regtest" | "other";
  /** In sats, when the offer fixes an amount in bitcoin; `currency` when it is priced in another currency. */
  amountSat?: number;
  amountMsat?: bigint;
  currency?: string;
  currencyAmount?: bigint;
  description?: string;
  issuer?: string;
}

// Genesis block hashes as BOLT 12 writes them (the bytes of the block hash, in Bitcoin's internal order).
const CHAINS: Record<string, Bolt12Offer["chain"]> = {
  "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000": "bitcoin",
  "43497fd7f826957108f4a30fd9cec3aeba79972084e90ead01ea330900000000": "testnet",
  "f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000": "signet",
  "06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f": "regtest",
};

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** BOLT 1 BigSize: the value and the bytes it took, or null when it is cut short or not minimal. */
function bigSize(bytes: Uint8Array, at: number): [bigint, number] | null {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (width === 0) return [BigInt(first), 1];
  if (at + 1 + width > bytes.length) return null;
  let value = 0n;
  for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[at + 1 + i]);
  const min = width === 2 ? 0xfdn : width === 4 ? 0x10000n : 0x100000000n;
  return value < min ? null : [value, 1 + width];
}

/** A truncated unsigned integer (`tu64`): big-endian, no leading zero byte. */
function tu64(bytes: Uint8Array): bigint | null {
  if (bytes.length > 8 || (bytes.length > 0 && bytes[0] === 0)) return null;
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function utf8(bytes: Uint8Array): string | undefined {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, 280); } catch { return undefined; }
}

/**
 * Decodes an `lno1…` string: bech32 without a checksum, possibly split with `+` and whitespace, holding a TLV
 * stream in increasing type order. Null for anything that is not a well-formed offer: a string that merely
 * starts with `lno1` is not one.
 */
export function decodeBolt12Offer(text: string): Bolt12Offer | null {
  const joined = text.replace(/\+\s*/g, "");
  if (joined !== joined.toLowerCase() && joined !== joined.toUpperCase()) return null;
  const lower = joined.toLowerCase();
  if (!/^lno1[02-9ac-hj-np-z]{20,}$/.test(lower)) return null;
  let bytes: Uint8Array;
  try {
    const words = [...lower.slice(4)].map((c) => BECH32_CHARSET.indexOf(c));
    if (words.some((w) => w < 0)) return null;
    bytes = bech32.fromWordsUnsafe(words) ?? new Uint8Array();
    if (!bytes.length) return null;
  } catch { return null; }
  const offer: Bolt12Offer = { offer: lower, network: "mainnet", chain: "bitcoin" };
  let at = 0, last = -1n, hasIssuerId = false, hasPaths = false;
  while (at < bytes.length) {
    const type = bigSize(bytes, at);
    if (!type) return null;
    const length = bigSize(bytes, at + type[1]);
    if (!length) return null;
    const start = at + type[1] + length[1], end = start + Number(length[0]);
    if (type[0] <= last || end > bytes.length) return null;
    last = type[0];
    const value = bytes.subarray(start, end);
    switch (Number(type[0])) {
      case 2: {
        if (value.length === 0 || value.length % 32) return null;
        const chains = new Set<Bolt12Offer["chain"]>();
        for (let i = 0; i < value.length; i += 32) chains.add(CHAINS[hex(value.subarray(i, i + 32))] ?? "other");
        offer.chain = chains.has("bitcoin") ? "bitcoin" : [...chains][0];
        // An offer for Bitcoin and a test chain both is real money: the stricter reading.
        offer.network = chains.has("bitcoin") ? "mainnet" : "testnet";
        break;
      }
      case 6: offer.currency = utf8(value); break;
      case 8: {
        const amount = tu64(value);
        if (amount === null) return null;
        offer.amountMsat = amount;
        break;
      }
      case 10: offer.description = utf8(value); break;
      case 16: hasPaths = value.length > 0; break;
      case 18: offer.issuer = utf8(value); break;
      case 22: hasIssuerId = value.length === 33; break;
    }
    at = end;
  }
  // BOLT 12: an offer names its issuer's key or the blinded paths to reach it.
  if (!hasIssuerId && !hasPaths) return null;
  if (offer.amountMsat !== undefined) {
    if (offer.currency) { offer.currencyAmount = offer.amountMsat; delete offer.amountMsat; }
    else if (offer.amountMsat % 1000n === 0n) offer.amountSat = Number(offer.amountMsat / 1000n);
  }
  return offer;
}

const OFFER_WORD = /(?<![A-Za-z0-9])(?:(?:lightning:|bitcoin:\?(?:[^\s]*&)?lno=))?(lno1[02-9ac-hj-np-z]+(?:\+\s*[02-9ac-hj-np-z]+)*|LNO1[02-9AC-HJ-NP-Z]+(?:\+\s*[02-9AC-HJ-NP-Z]+)*)/g;

/** A BOLT 12 offer anywhere in a message, bare, `lightning:` or in a `bitcoin:?lno=` link. */
export function findBolt12Offer(text: string): { offer: Bolt12Offer; rest: string } | null {
  for (const match of text.matchAll(OFFER_WORD)) {
    const decoded = insideUrl(text, match.index!) ? null : decodeBolt12Offer(match[1]);
    if (!decoded) continue;
    // The rest of a `bitcoin:` link around the offer goes with it.
    const whole = match[0].startsWith("bitcoin:") ? trimUriEnd(text.slice(match.index!).split(/\s/)[0]) : match[0];
    return { offer: decoded, rest: cut(text, match.index!, whole.length) };
  }
  return null;
}
