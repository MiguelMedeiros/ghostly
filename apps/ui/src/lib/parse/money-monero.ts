import { keccak_256 } from "@noble/hashes/sha3.js";
import type { WalletNetwork } from "@ghostly/core";
import { cut, insideUrl, trimUriEnd, URI_MAX_CHARS } from "./money-text";

export type MoneroChain = "mainnet" | "stagenet" | "testnet";

/**
 * A Monero address or `monero:` link. There is no Monero wallet in the app: the card shows it and hands the link to
 * the person's own wallet. Stagenet and testnet coins are test money (`network` "testnet").
 */
export interface MoneroRequest {
  address: string;
  kind: "standard" | "subaddress" | "integrated";
  chain: MoneroChain;
  network: WalletNetwork;
  /** In piconero (12 decimals), from a link's `tx_amount`. */
  amount?: bigint;
  recipientName?: string;
  description?: string;
  /** The `monero:` link rebuilt from what was read here (no parameter this app does not know). */
  uri: string;
}

/** Network byte → what it is (Monero's src/cryptonote_config.h, `CRYPTONOTE_PUBLIC_*_BASE58_PREFIX`). */
const PREFIXES: Record<number, Pick<MoneroRequest, "kind" | "chain">> = {
  18: { kind: "standard", chain: "mainnet" }, 19: { kind: "integrated", chain: "mainnet" }, 42: { kind: "subaddress", chain: "mainnet" },
  24: { kind: "standard", chain: "stagenet" }, 25: { kind: "integrated", chain: "stagenet" }, 36: { kind: "subaddress", chain: "stagenet" },
  53: { kind: "standard", chain: "testnet" }, 54: { kind: "integrated", chain: "testnet" }, 63: { kind: "subaddress", chain: "testnet" },
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Monero's Base58 works in blocks of 8 bytes, 11 characters; a last, shorter block takes these many characters. */
const BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11];

/** Monero's block Base58 (src/common/base58.cpp), or null when a block is not one it could have written. */
export function moneroBase58Decode(text: string): Uint8Array | null {
  const full = Math.floor(text.length / 11), lastChars = text.length % 11;
  const lastBytes = BLOCK_CHARS.indexOf(lastChars);
  if (lastBytes < 0) return null;
  const out = new Uint8Array(full * 8 + lastBytes);
  for (let block = 0; block <= full; block++) {
    const chars = text.slice(block * 11, block * 11 + 11), size = block < full ? 8 : lastBytes;
    if (!size) break;
    let value = 0n;
    for (const c of chars) {
      const digit = ALPHABET.indexOf(c);
      if (digit < 0) return null;
      value = value * 58n + BigInt(digit);
    }
    if (value >> BigInt(size * 8)) return null;
    for (let i = size - 1; i >= 0; i--, value >>= 8n) out[block * 8 + i] = Number(value & 0xffn);
  }
  return out;
}

/** What a Monero address is: its kind and chain, or null when its length, network byte or checksum is wrong. */
export function decodeMoneroAddress(address: string): Pick<MoneroRequest, "kind" | "chain" | "network"> | null {
  if (address.length !== 95 && address.length !== 106) return null;
  const bytes = moneroBase58Decode(address);
  // Every network byte here is under 0x80: its varint is the one byte.
  const known = bytes ? PREFIXES[bytes[0]] : undefined;
  if (!bytes || !known) return null;
  // The network byte, the spend and view keys, the 8-byte payment ID of an integrated address, then the checksum.
  if (bytes.length !== (known.kind === "integrated" ? 77 : 69)) return null;
  const body = bytes.subarray(0, -4), sum = keccak_256(body);
  if (!bytes.subarray(-4).every((byte, i) => byte === sum[i])) return null;
  return { ...known, network: known.chain === "mainnet" ? "mainnet" : "testnet" };
}

/** A `tx_amount` (XMR, a decimal) in piconero, or null when it is not one. */
export function xmrToPiconero(text: string): bigint | null {
  const match = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(text);
  return match ? BigInt(match[1] + (match[2] ?? "").padEnd(12, "0")) : null;
}

/** Percent-encoded down to letters, digits and `-_.`: what Desktop's opener takes in a payment link. */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function moneroUri(address: string, amount?: string, name?: string, description?: string): string {
  const params = [amount && `tx_amount=${amount}`, name && `recipient_name=${encode(name)}`, description && `tx_description=${encode(description)}`].filter(Boolean);
  return `monero:${address}${params.length ? `?${params.join("&")}` : ""}`;
}

/**
 * A name or description at most 140 characters long, as the Bitcoin card cuts a label (money-bitcoin.ts), on whole
 * characters. Encoded again, one character can be 12 in the link: whole, a long one or one in another script took the
 * link past the 4,096 characters Desktop and the extension open.
 */
const field = (value: string | null) => Array.from(value?.trim() ?? "").slice(0, 140).join("").trim() || undefined;

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const URI = new RegExp(`(?<![A-Za-z0-9])monero:(${B58}{95}(?:${B58}{11})?)(?![A-Za-z0-9])(\\?[^\\s<>"'\`]*)?`, "gi");
const BARE = new RegExp(`(?<![A-Za-z0-9])${B58}{95}(?:${B58}{11})?(?![A-Za-z0-9])`, "g");

/**
 * A Monero address in a message: a `monero:` link (with `tx_amount`, `recipient_name`, `tx_description`; other
 * parameters ignored), or a bare address. Only one whose checksum holds: a string that merely looks like one is text.
 */
export function findMoneroAddress(text: string): { request: MoneroRequest; rest: string } | null {
  for (const match of text.matchAll(URI)) {
    if (match[0].length > URI_MAX_CHARS) return null;
    const uri = trimUriEnd(match[0]);
    const address = match[1], decoded = decodeMoneroAddress(address);
    // A link to several people (`addr1;addr2`) or with an amount this cannot read is not offered at all.
    if (!decoded || text[match.index! + match[0].length] === ";") return null;
    const params = new URLSearchParams(uri.slice(`monero:${address}`.length + 1));
    const raw = params.get("tx_amount");
    const amount = raw === null ? undefined : xmrToPiconero(raw);
    if (amount === null) return null;
    const recipientName = field(params.get("recipient_name")), description = field(params.get("tx_description"));
    const kept = amount ? raw! : undefined;
    return {
      request: { address, ...decoded, ...(kept ? { amount } : {}), ...(recipientName ? { recipientName } : {}), ...(description ? { description } : {}), uri: moneroUri(address, kept, recipientName, description) },
      rest: cut(text, match.index!, uri.length),
    };
  }
  // A link this could not read is not searched for a bare address.
  if (/(?<![A-Za-z0-9])monero:/i.test(text)) return null;
  for (const match of text.matchAll(BARE)) {
    const decoded = insideUrl(text, match.index!) ? null : decodeMoneroAddress(match[0]);
    if (decoded) return { request: { address: match[0], ...decoded, uri: `monero:${match[0]}` }, rest: cut(text, match.index!, match[0].length) };
  }
  return null;
}
