import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, bech32m, createBase58check } from "@scure/base";
import {
  BitcoinAddressError, compactSize, decodeAnyBitcoinAddress, decodeBitcoinAddress, decodeTx, decodeWitness, encodeTx, encodeWitness, isBitcoinAddress,
  type Tx,
} from "../src";
import generated from "./fixtures/bip322/generated-test-vectors.json";

const base58 = createBase58check(sha256);
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const segwitAddress = (hrp: string, version: number, program: Uint8Array) =>
  (version === 0 ? bech32 : bech32m).encode(hrp, [version, ...bech32.toWords(program)]);
/** A real signed transaction: the BIP-322 full P2WPKH vector (segwit serialisation). */
const FULL_TX = b64(generated.full.find(v => v.type === "p2wpkh")!.bip322_signatures[0].slice(3));

describe("addresses a proof may name", () => {
  it("decodes every script type to its output script", () => {
    const p = new Uint8Array(32).fill(7);
    expect(decodeBitcoinAddress(segwitAddress("bc", 1, p), "mainnet")).toMatchObject({ type: "p2tr", witnessVersion: 1, scriptPubKey: Uint8Array.of(0x51, 32, ...p) });
    expect(decodeBitcoinAddress(segwitAddress("bc", 0, p), "mainnet")).toMatchObject({ type: "p2wsh", scriptPubKey: Uint8Array.of(0x00, 32, ...p) });
    expect(decodeBitcoinAddress(segwitAddress("bc", 1, p.subarray(0, 20)), "mainnet").type).toBe("witness-unknown");
    expect(decodeBitcoinAddress(segwitAddress("bc", 16, p.subarray(0, 2)), "mainnet")).toMatchObject({ type: "witness-unknown", scriptPubKey: Uint8Array.of(0x60, 2, 7, 7) });
    expect(decodeBitcoinAddress(segwitAddress("bc", 0, p.subarray(0, 20)).toUpperCase(), "mainnet").type).toBe("p2wpkh");
  });

  it("refuses short, long and non-string input with one plain reason", () => {
    for (const bad of ["", "1".repeat(13), `bc1${"q".repeat(88)}`, 42, null])
      expect(() => decodeBitcoinAddress(bad as string, "mainnet")).toThrow(new BitcoinAddressError("Not a Bitcoin address"));
  });

  it("refuses another coin's prefix without calling it a test network", () => {
    const ltc = segwitAddress("ltc", 0, new Uint8Array(20));
    expect(() => decodeBitcoinAddress(ltc, "mainnet")).toThrow(/^Not a Bitcoin address$/);
    expect(() => decodeBitcoinAddress(ltc, "testnet")).toThrow(/^Not a Bitcoin address$/);
    const litecoinP2pkh = base58.encode(Uint8Array.of(0x30, ...new Uint8Array(20)));
    expect(() => decodeBitcoinAddress(litecoinP2pkh, "mainnet")).toThrow(/^Not a Bitcoin address$/);
  });

  it("names the network a base58 address belongs to", () => {
    const testnetP2sh = base58.encode(Uint8Array.of(0xc4, ...new Uint8Array(20)));
    expect(() => decodeBitcoinAddress(testnetP2sh, "mainnet")).toThrow(/test-network address/);
    const mainnetP2sh = base58.encode(Uint8Array.of(0x05, ...new Uint8Array(20)));
    expect(() => decodeBitcoinAddress(mainnetP2sh, "testnet")).toThrow(/mainnet address/);
  });

  it("refuses base58 payloads of the wrong size and bad checksums", () => {
    expect(() => decodeBitcoinAddress(base58.encode(new Uint8Array(22)), "mainnet")).toThrow(/^Not a Bitcoin address$/);
    expect(() => decodeBitcoinAddress(base58.encode(new Uint8Array(20)), "mainnet")).toThrow(/^Not a Bitcoin address$/);
    expect(() => decodeBitcoinAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "mainnet")).toThrow(/bad checksum/);
  });

  it("refuses the wrong checksum kind for a witness version, bad versions and program sizes (BIP 173/350)", () => {
    const words = (version: number, program: Uint8Array) => [version, ...bech32.toWords(program)];
    const bad = [
      bech32.encode("bc", words(1, new Uint8Array(32))), // v1 with bech32
      bech32m.encode("bc", words(0, new Uint8Array(20))), // v0 with bech32m
      bech32m.encode("bc", words(17, new Uint8Array(20))), // no version 17
      bech32m.encode("bc", words(2, new Uint8Array(41))), // program over 40 bytes
      bech32m.encode("bc", words(2, new Uint8Array(1)).concat([0, 0, 0, 0, 0, 0, 0])), // non-zero padding / bad regroup
      bech32.encode("bc", words(0, new Uint8Array(21))), // v0 is 20 or 32 bytes
      segwitAddress("bc", 0, new Uint8Array(20)).replace("bc1q", "bc1Q"), // mixed case
    ];
    for (const address of bad) expect(() => decodeBitcoinAddress(address, "mainnet"), address).toThrow(BitcoinAddressError);
  });

  it("decodes on whichever network the address belongs to, and passes other refusals through", () => {
    expect(decodeAnyBitcoinAddress(segwitAddress("bc", 0, new Uint8Array(20))).network).toBe("mainnet");
    expect(decodeAnyBitcoinAddress(segwitAddress("bcrt", 0, new Uint8Array(20))).network).toBe("testnet");
    expect(() => decodeAnyBitcoinAddress("not an address at all")).toThrow(/^Not a Bitcoin address/);
  });

  it("never throws anything but a BitcoinAddressError, and agrees with the payment-side check", () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 100 }), fc.stringMatching(/^(bc|tb|bcrt)1[02-9ac-hj-np-z]{8,80}$/)), text => {
      let decoded: ReturnType<typeof decodeBitcoinAddress> | undefined;
      try { decoded = decodeBitcoinAddress(text, "mainnet"); } catch (e) { expect(e).toBeInstanceOf(BitcoinAddressError); }
      if (decoded && decoded.type !== "p2pkh" && decoded.type !== "p2sh") expect(isBitcoinAddress(text, "bitcoin")).toBe(true);
    }), { numRuns: 300 });
  });
});

describe("compact sizes", () => {
  it("uses the shortest encoding at every boundary", () => {
    expect(compactSize(0xfc)).toEqual(Uint8Array.of(0xfc));
    expect(compactSize(0xfd)).toEqual(Uint8Array.of(0xfd, 0xfd, 0x00));
    expect(compactSize(0xffff)).toEqual(Uint8Array.of(0xfd, 0xff, 0xff));
    expect(compactSize(0x10000)).toEqual(Uint8Array.of(0xfe, 0x00, 0x00, 0x01, 0x00));
    expect(compactSize(0xffffffff)).toEqual(Uint8Array.of(0xfe, 0xff, 0xff, 0xff, 0xff));
    expect(() => compactSize(0x100000000)).toThrow("Too large");
  });

  it("refuses a size in a longer form than needed, and sizes over the consensus limit", () => {
    const stack = (size: number[]) => Uint8Array.of(...size);
    expect(() => decodeWitness(stack([0xfd, 0x05, 0x00]))).toThrow("Non-canonical size");
    expect(() => decodeWitness(stack([0xfe, 0xff, 0xff, 0x00, 0x00]))).toThrow("Non-canonical size");
    expect(() => decodeWitness(stack([0xff, 1, 0, 0, 0, 0, 0, 0, 0]))).toThrow("Non-canonical size");
    expect(() => decodeWitness(stack([0xfe, 0x01, 0x00, 0x00, 0x02]))).toThrow("Non-canonical size");
    // Exactly at the limit the size is read, and then the data is missing.
    expect(() => decodeWitness(stack([0xfe, 0x00, 0x00, 0x00, 0x02]))).toThrow("Truncated data");
  });
});

describe("witness stacks", () => {
  it("round-trip, and anything else is refused with a reader error", () => {
    fc.assert(fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 8 }), stack => {
      const encoded = encodeWitness(stack);
      expect(decodeWitness(encoded)).toEqual(stack);
      expect(() => decodeWitness(Uint8Array.of(...encoded, 0))).toThrow("Unexpected trailing data");
      if (encoded.length > 1) expect(() => decodeWitness(encoded.subarray(0, -1))).toThrow("Truncated data");
    }), { numRuns: 200 });
    expect(() => decodeWitness(new Uint8Array(0))).toThrow("Truncated data");
  });
});

describe("transactions", () => {
  it("decodes a real signed transaction and re-encodes it byte for byte", () => {
    const tx = decodeTx(FULL_TX);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0].witness).toHaveLength(2);
    expect(encodeTx(tx)).toEqual(FULL_TX);
  });

  it("refuses every truncation of it and any trailing byte", () => {
    for (let n = 0; n < FULL_TX.length; n++) expect(() => decodeTx(FULL_TX.subarray(0, n)), `${n} bytes`).toThrow();
    expect(() => decodeTx(Uint8Array.of(...FULL_TX, 0))).toThrow("Unexpected trailing data");
  });

  it("refuses an unknown segwit flag and an empty witness behind the flag", () => {
    const flagged = FULL_TX.slice();
    expect(flagged[4]).toBe(0x00);
    flagged[5] = 0x02;
    expect(() => decodeTx(flagged)).toThrow("Unknown transaction flag");
    const tx = decodeTx(FULL_TX);
    const empty: Tx = { ...tx, inputs: tx.inputs.map(i => ({ ...i, witness: [] })) };
    expect(() => decodeTx(encodeTx(empty, true))).toThrow("Superfluous witness flag");
    expect(decodeTx(encodeTx(empty, false)).inputs[0].witness).toEqual([]);
  });

  it("round-trips arbitrary transactions in both serialisations", () => {
    const input = fc.record({
      txid: fc.uint8Array({ minLength: 32, maxLength: 32 }), vout: fc.nat({ max: 0xffffffff }), scriptSig: fc.uint8Array({ maxLength: 80 }),
      sequence: fc.nat({ max: 0xffffffff }), witness: fc.array(fc.uint8Array({ maxLength: 80 }), { maxLength: 3 }),
    });
    const output = fc.record({ value: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), script: fc.uint8Array({ maxLength: 80 }) });
    fc.assert(fc.property(fc.record({ version: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), inputs: fc.array(input, { minLength: 1, maxLength: 3 }), outputs: fc.array(output, { maxLength: 3 }), lockTime: fc.nat({ max: 0xffffffff }) }), tx => {
      const decoded = decodeTx(encodeTx(tx));
      expect(decoded).toEqual(tx.inputs.some(i => i.witness.length) ? tx : { ...tx, inputs: tx.inputs.map(i => ({ ...i, witness: [] })) });
    }), { numRuns: 200 });
  });

  it("never throws anything but a reader error on arbitrary bytes", () => {
    const known = /^(Truncated data|Non-canonical size|Unexpected trailing data|Unknown transaction flag|Superfluous witness flag)$/;
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), bytes => {
      try { decodeTx(bytes); } catch (e) { expect((e as Error).message).toMatch(known); }
      try { decodeWitness(bytes); } catch (e) { expect((e as Error).message).toMatch(known); }
    }), { numRuns: 300 });
  });
});
