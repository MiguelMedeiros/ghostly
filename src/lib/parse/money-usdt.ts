import { keccak_256 } from "@noble/hashes/sha3.js";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT, type WalletNetwork } from "@ghostly/core";
import { cut, insideUrl, trimUriEnd } from "./money-text";

/** The EVM chains a USDT wallet here runs on, by EIP-155 chain ID. */
export const USDT_CHAINS: Record<number, { name: string; network: WalletNetwork }> = {
  1: { name: "Ethereum", network: "mainnet" },
  11155111: { name: "Sepolia", network: "testnet" },
  31337: { name: "Local chain", network: "testnet" },
};

/**
 * A USDT payment address. A bare `0x…` string could be anything on any EVM chain, so it only counts with USDT
 * named next to it, and then its chain is unknown (`network` absent): shown, never paid. An EIP-681 link says
 * its chain; a `transfer` link names the token and the amount too.
 */
export interface UsdtRequest {
  recipient: string;
  chainId?: number;
  /** Absent: the chain is not stated, or not one of `USDT_CHAINS`. */
  network?: WalletNetwork;
  /** The token contract a `transfer` link names. */
  token?: string;
  /** In the token's base units (USDT: 6 decimals), from a `transfer` link. */
  amount?: bigint;
  uri?: string;
}

/**
 * EIP-55: an all-lower or all-upper address has no checksum; a mixed-case one must match it. The zero address is
 * refused: whatever is sent there is burnt.
 */
export function isEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = keccak_256(new TextEncoder().encode(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf;
    const c = body[i];
    if (/[a-f]/.test(c) && nibble >= 8) return false;
    if (/[A-F]/.test(c) && nibble < 8) return false;
  }
  return true;
}

/** An EIP-681 number (`1500000`, `1.5e6`): an exact whole number, or null. */
export function eip681Number(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?(?:e(\d{1,3}))?$/i.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "", exponent = Number(match[3] ?? "0");
  if (fraction.replace(/0+$/, "").length > exponent) return null;
  return BigInt(match[1] + fraction.padEnd(exponent, "0").slice(0, exponent));
}

const KNOWN_USDT: Record<number, string> = { 1: ETHEREUM_USDT.toLowerCase(), 11155111: SEPOLIA_TEST_USDT.toLowerCase() };
const USDT_WORD = /(?<![A-Za-z0-9])usdt(?![A-Za-z0-9])/i;
const EIP681 = /(?<![A-Za-z0-9])ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d{1,12}))?(?:\/([A-Za-z_]\w*))?(\?[^\s<>"'`]*)?/gi;
const BARE = /(?<![A-Za-z0-9])0x[0-9a-fA-F]{40}(?![A-Za-z0-9])/g;

function chainOf(chainId: number | undefined): Pick<UsdtRequest, "chainId" | "network"> {
  if (chainId === undefined) return {};
  const known = USDT_CHAINS[chainId];
  return known ? { chainId, network: known.network } : { chainId };
}

/** A USDT address in a message: an `ethereum:` link, or a bare `0x…` address with "USDT" in the message. */
export function findUsdtAddress(text: string): { request: UsdtRequest; rest: string } | null {
  const mentioned = USDT_WORD.test(text);
  for (const match of text.matchAll(EIP681)) {
    const uri = trimUriEnd(match[0]);
    const [, target, chain, fn, query] = match;
    const params = new URLSearchParams((query ?? "").slice(1).replace(/\+/g, "%2B"));
    const chainId = chain === undefined ? undefined : Number(chain);
    let request: UsdtRequest | null = null;
    if (fn?.toLowerCase() === "transfer") {
      const recipient = params.get("address") ?? "";
      if (!isEvmAddress(target) || !isEvmAddress(recipient)) continue;
      const token = target.toLowerCase();
      // A transfer of a token that is not USDT here, with nothing saying it is: not this card's.
      if (!mentioned && (chainId === undefined || KNOWN_USDT[chainId] !== token)) continue;
      const raw = params.get("uint256");
      const amount = raw === null ? null : eip681Number(trimUriEnd(raw));
      request = { recipient, ...chainOf(chainId), token, ...(amount && amount > 0n ? { amount } : {}), uri };
    } else if (!fn && mentioned && isEvmAddress(target)) {
      // A plain `ethereum:` link to an address, with USDT named: its `value` is ether, not USDT, so no amount.
      request = { recipient: target, ...chainOf(chainId), uri };
    }
    if (request) return { request, rest: cut(text, match.index!, uri.length) };
  }
  // A link this could not read is not searched for a bare address: it would find the token's or a mangled one.
  if (!mentioned || /(?<![A-Za-z0-9])ethereum:/i.test(text)) return null;
  for (const match of text.matchAll(BARE)) {
    if (!insideUrl(text, match.index!) && isEvmAddress(match[0])) return { request: { recipient: match[0] }, rest: cut(text, match.index!, match[0].length) };
  }
  return null;
}
