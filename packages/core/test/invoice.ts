import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

/**
 * A signed BOLT 11 invoice from a node that does not exist, for tests that need one with a chosen amount,
 * description or description hash (an LNURL service commits to its metadata through the `h` tag).
 */
export function testInvoice(options: { sats?: number; msat?: bigint; description?: string; descriptionHash?: Uint8Array; prefix?: string; expirySeconds?: number; createdAt?: number } = {}): string {
  const words: number[] = [...uint(options.createdAt ?? Math.floor(Date.now() / 1000), 7)];
  const field = (tag: number, data: number[]) => words.push(tag, data.length >> 5, data.length & 31, ...data);
  field(1, bech32.toWords(crypto.getRandomValues(new Uint8Array(32)))); // p: payment hash
  field(16, bech32.toWords(crypto.getRandomValues(new Uint8Array(32)))); // s: payment secret
  if (options.descriptionHash) field(23, bech32.toWords(options.descriptionHash)); // h
  else field(13, bech32.toWords(new TextEncoder().encode(options.description ?? "test"))); // d
  field(6, uint(options.expirySeconds ?? 3600)); // x
  field(24, uint(18)); // c
  field(5, [16, 8, 0]); // 9: features
  const msat = options.msat ?? BigInt(options.sats ?? 21) * 1000n;
  // Nano-bitcoin (100 msat) when it divides; otherwise pico-bitcoin (a tenth of a msat).
  const amount = msat % 100n === 0n ? `${msat / 100n}n` : `${msat * 10n}p`;
  const hrp = `${options.prefix ?? "lnbc"}${amount}`;
  const signed = secp256k1.sign(sha256(new Uint8Array([...new TextEncoder().encode(hrp), ...toBytes(words)])), secp256k1.utils.randomSecretKey(), { prehash: false, format: "recovered" });
  const signature = new Uint8Array([...signed.slice(1), signed[0]]);
  return bech32.encode(hrp, [...words, ...bech32.toWords(signature)], false);
}

function uint(value: number, length?: number): number[] {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 32)) out.unshift(v % 32);
  while (out.length < (length ?? 1)) out.unshift(0);
  return out;
}

function toBytes(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 255);
  return new Uint8Array(out);
}
