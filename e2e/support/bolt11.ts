import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

/**
 * A signed BOLT11 invoice from a node that does not exist: something for a test mint to pay that is
 * not one of its own invoices. A test mint marks its own invoices paid by itself, so paying one of those
 * proves nothing about a Lightning send; paying this one goes through the mint's melt for real.
 */
export function strangerInvoice(sats: number, description = "ghostly e2e"): string {
  const words: number[] = [...uint(Math.floor(Date.now() / 1000), 7)];
  const field = (tag: number, data: number[]) => words.push(tag, data.length >> 5, data.length & 31, ...data);
  field(1, bech32.toWords(crypto.getRandomValues(new Uint8Array(32)))); // p: payment hash
  field(16, bech32.toWords(crypto.getRandomValues(new Uint8Array(32)))); // s: payment secret
  field(13, bech32.toWords(new TextEncoder().encode(description))); // d
  field(6, uint(3600)); // x: expiry, seconds
  field(24, uint(18)); // c: final CLTV delta
  field(5, [16, 8, 0]); // 9: features, var_onion_optin and payment_secret (bits 8 and 14)
  const hrp = `lnbc${sats * 10}n`;
  const signed = secp256k1.sign(sha256(new Uint8Array([...new TextEncoder().encode(hrp), ...toBytes(words)])), secp256k1.utils.randomSecretKey(), { prehash: false, format: "recovered" });
  // noble puts the recovery id first; BOLT11 wants it last.
  const signature = new Uint8Array([...signed.slice(1), signed[0]]);
  return bech32.encode(hrp, [...words, ...bech32.toWords(signature)], false);
}

/** Big-endian 5-bit words, `length` of them or as few as the value needs. */
function uint(value: number, length?: number): number[] {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 32)) out.unshift(v % 32);
  while (out.length < (length ?? 1)) out.unshift(0);
  return out;
}

/** 5-bit words to bytes, the last one padded with zero bits (how BOLT11 signs its data part). */
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
