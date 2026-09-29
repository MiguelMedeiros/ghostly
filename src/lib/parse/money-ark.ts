import { bech32m } from "@scure/base";
import type { WalletNetwork } from "@ghostly/core";
import { btcToSats, findBip21 } from "./money-bitcoin";
import { cut, insideUrl } from "./money-text";

/**
 * An Ark address. Two Ark implementations run beside each other and never pay each other: Arkade (`arkade`,
 * version 0: `ark1q…` / `tark1q…`, the server's key and the output key) and Second's Bark (`bark`, version 1:
 * `ark1p…` / `tark1p…`). Both are bech32m with `ark` on Bitcoin and `tark` on test networks.
 */
export interface ArkRequest {
  address: string;
  kind: "arkade" | "bark";
  network: WalletNetwork;
  amountSat?: number;
  /** The whole `bitcoin:?ark=` link, when it came in one. */
  uri?: string;
}

/** A Bitcoin compact size at `at`: the value and the bytes it took, or null when cut short. */
function compactSize(bytes: Uint8Array, at: number): [number, number] | null {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  if (first < 0xfd) return [first, 1];
  // Longer than any policy or delivery (bark caps them far below 64 KiB).
  if (first !== 0xfd || at + 3 > bytes.length) return null;
  return [bytes[at + 1] | (bytes[at + 2] << 8), 3];
}

/**
 * Bark's payload (bark lib/src/address.rs): a 4-byte Ark ID (from the server's key), the VTXO policy with its
 * length, then any number of delivery options, each with its length. Whether the policy itself is one Bark
 * accepts is left to the Bark wallet at payment time.
 */
function isBarkPayload(bytes: Uint8Array): boolean {
  let at = 4;
  const policy = compactSize(bytes, at);
  if (!policy || policy[0] === 0) return false;
  at += policy[1] + policy[0];
  if (at > bytes.length) return false;
  while (at < bytes.length) {
    const delivery = compactSize(bytes, at);
    if (!delivery) return false;
    at += delivery[1] + delivery[0];
    if (at > bytes.length) return false;
  }
  return true;
}

/** Which Ark an address is for, or null when it is not a well-formed Ark address. */
export function decodeArkAddress(text: string): Pick<ArkRequest, "kind" | "network"> | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const lower = text.toLowerCase() as `${string}1${string}`;
  let decoded: { prefix: string; words: number[] };
  try { decoded = bech32m.decode(lower, 1023); } catch { return null; }
  if (decoded.prefix !== "ark" && decoded.prefix !== "tark") return null;
  const network: WalletNetwork = decoded.prefix === "ark" ? "mainnet" : "testnet";
  const [version] = decoded.words;
  try {
    // Arkade: the whole data part is bytes, version byte 0 then two 32-byte keys (the server's and the output's).
    if (version === 0) {
      const payload = bech32m.fromWords(decoded.words);
      return payload.length === 65 && payload[0] === 0 ? { kind: "arkade", network } : null;
    }
    // Bark: the first character is the version (1), the rest its payload.
    if (version === 1) return isBarkPayload(bech32m.fromWords(decoded.words.slice(1))) ? { kind: "bark", network } : null;
  } catch { return null; }
  return null;
}

const ARK_WORD = /(?<![A-Za-z0-9])(?:t?ark1[02-9ac-hj-np-z]{50,}|T?ARK1[02-9AC-HJ-NP-Z]{50,})(?![A-Za-z0-9])/g;

/** An Ark address anywhere in a message, or in a `bitcoin:?ark=` link (with its amount). */
export function findArkAddress(text: string): { request: ArkRequest; rest: string } | null {
  for (const link of findBip21(text)) {
    const address = link.params.get("ark");
    const decoded = address ? decodeArkAddress(address) : null;
    if (!address || !decoded || link.address) continue;
    const amount = link.params.get("amount");
    const sats = amount === undefined ? undefined : btcToSats(amount) ?? undefined;
    return { request: { address: address.toLowerCase(), ...decoded, ...(sats ? { amountSat: sats } : {}), uri: link.uri }, rest: cut(text, link.index, link.uri.length) };
  }
  for (const match of text.matchAll(ARK_WORD)) {
    const decoded = insideUrl(text, match.index!) ? null : decodeArkAddress(match[0]);
    if (decoded) return { request: { address: match[0].toLowerCase(), ...decoded }, rest: cut(text, match.index!, match[0].length) };
  }
  return null;
}
