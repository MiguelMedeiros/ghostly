import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, bech32m, createBase58check } from "@scure/base";

/** The Bitcoin networks an on-chain wallet can be on. Only `bitcoin` is real money. */
export type BitcoinNetwork = "bitcoin" | "signet" | "testnet" | "regtest" | "mutinynet";
export const BITCOIN_NETWORKS: readonly BitcoinNetwork[] = ["bitcoin", "signet", "testnet", "regtest", "mutinynet"];

/** Mutinynet is a signet: it shares signet's (and testnet's) address prefixes. */
const SEGWIT_HRP: Record<BitcoinNetwork, string> = { bitcoin: "bc", signet: "tb", testnet: "tb", mutinynet: "tb", regtest: "bcrt" };
const BASE58_VERSIONS: Record<BitcoinNetwork, readonly number[]> = { bitcoin: [0x00, 0x05], signet: [0x6f, 0xc4], testnet: [0x6f, 0xc4], mutinynet: [0x6f, 0xc4], regtest: [0x6f, 0xc4] };
const base58check = createBase58check(sha256);

function segwit(address: string, hrp: string): boolean {
  // BIP 173: one case only. The checksum is over the lower-case form.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
  const lower = address.toLowerCase();
  if (!lower.startsWith(`${hrp}1`) || lower.length > 90) return false;
  // Version 0 is bech32 (BIP 173), every later version bech32m (BIP 350); the wrong one is refused.
  for (const [coder, v0] of [[bech32, true], [bech32m, false]] as const) {
    let decoded: { prefix: string; words: number[] };
    try { decoded = coder.decode(lower as `${string}1${string}`, 90); } catch { continue; }
    if (decoded.prefix !== hrp || decoded.words.length < 1) return false;
    const version = decoded.words[0];
    if (version > 16 || (version === 0) !== v0) return false;
    let program: Uint8Array;
    try { program = coder.fromWords(decoded.words.slice(1)); } catch { return false; }
    if (version === 0) return program.length === 20 || program.length === 32;
    return program.length >= 2 && program.length <= 40;
  }
  return false;
}

/** Whether `address` is a valid address on `network`: checksums, witness versions, lengths and prefixes. */
export function isBitcoinAddress(address: unknown, network: BitcoinNetwork): boolean {
  if (typeof address !== "string" || !BITCOIN_NETWORKS.includes(network) || address.length < 14 || address.length > 90) return false;
  if (segwit(address, SEGWIT_HRP[network])) return true;
  let payload: Uint8Array;
  try { payload = base58check.decode(address); } catch { return false; }
  return payload.length === 21 && BASE58_VERSIONS[network].includes(payload[0]);
}
