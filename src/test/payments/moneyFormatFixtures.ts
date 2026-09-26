import { bech32, bech32m } from "@scure/base";

/**
 * Money strings for the parser's tests (unit, UI, e2e): published test vectors where they exist, built here where
 * a test needs its own (a regtest address, an offer with chosen fields). Test coins only.
 */

/** BIP 173 / BIP 350 vectors. */
export const BC1Q = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
export const TB1Q = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
export const BC1P = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
/** Base58check: the classic P2PKH and P2SH examples, and a testnet P2PKH. */
export const P2PKH = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
export const P2SH = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
export const TEST_P2PKH = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";

/** A regtest P2WPKH address for a 20-byte program (all `fill`). */
export function bcrt1q(fill = 7): string {
  return bech32.encode("bcrt", [0, ...bech32.toWords(new Uint8Array(20).fill(fill))]);
}

/** The same string with its last character changed: a broken checksum. */
export const corrupt = (text: string) => text.slice(0, -1) + (text.endsWith("q") ? "p" : "q");

/** Bark's own vectors (bark lib/src/address.rs `address_roundtrip`), accepted by the Bark WASM's validateArkAddress. */
export const BARK_MAINNET = "ark1pwh9vsmezqqpharv69q4z8m6x364d5m5prnmcalcalq9pdmzw0y7mpveck4pcfhezqypczkrrj3lkx5ue4qrf4jc7ztpt9htdttmh2judhqnu7aue8p0y9mqkr4cf5";
export const BARK_TESTNET = "tark1pwh9vsmezqqpharv69q4z8m6x364d5m5prnmcalcalq9pdmzw0y7mpveck4pcfhezqypczkrrj3lkx5ue4qrf4jc7ztpt9htdttmh2judhqnu7aue8p0y9mq47jn9z";

/** An Arkade address as the Arkade SDK encodes it: version byte 0, the server's key, the output key. */
export function arkadeAddress(hrp: "ark" | "tark" = "tark", server = 2, output = 3): string {
  const bytes = new Uint8Array(65);
  bytes.fill(server, 1, 33);
  bytes.fill(output, 33);
  return bech32m.encode(hrp, bech32m.toWords(bytes), 1023);
}

export const GENESIS = {
  bitcoin: "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000",
  regtest: "06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f",
  signet: "f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000",
};

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const tu64 = (value: number) => { const out: number[] = []; for (let v = BigInt(value); v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn)); return out; };

/** A BOLT 12 offer with the fields given, written as a TLV stream in bech32 without a checksum. */
export function bolt12Offer(fields: { chains?: (keyof typeof GENESIS)[]; amountMsat?: number; currency?: string; description?: string; issuer?: string } = {}): string {
  const records: [number, number[]][] = [];
  if (fields.chains) records.push([2, fields.chains.flatMap((c) => [...hexBytes(GENESIS[c])])]);
  if (fields.currency) records.push([6, [...new TextEncoder().encode(fields.currency)]]);
  if (fields.amountMsat !== undefined) records.push([8, tu64(fields.amountMsat)]);
  if (fields.description !== undefined) records.push([10, [...new TextEncoder().encode(fields.description)]]);
  if (fields.issuer) records.push([18, [...new TextEncoder().encode(fields.issuer)]]);
  records.push([22, [0x02, ...new Array(32).fill(0x4d)]]);
  const bytes = Uint8Array.from(records.flatMap(([type, value]) => [type, value.length, ...value]));
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return "lno1" + bech32.toWords(bytes).map((w) => charset[w]).join("");
}

/** BOLT 12's own minimal offer vector (description "Test vectors", issuer id only). */
export const BOLT12_SPEC_MINIMAL = "lno1pgx9getnwss8vetrw3hhyuckyypwa3eyt44h6txtxquqh7lz5djge4afgfjn7k4rgrkuag0jsd5xvxg";

/** EIP-55 examples: a checksummed address, and the same with one letter's case flipped. */
export const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const EVM_BAD_CASE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";
