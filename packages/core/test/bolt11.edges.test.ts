import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bech32 } from "@scure/base";
import { decodeBolt11, findBolt11 } from "../src";
import { testInvoice } from "./invoice";

// covers: payments.bolt11

// BOLT 11's own example ("1 cup coffee", 2500u, 60 s expiry), for mutations.
const SPEC_INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const uint = (value: number, length = 1) => { const out: number[] = []; for (let v = value; v > 0; v = Math.floor(v / 32)) out.unshift(v % 32); while (out.length < length) out.unshift(0); return out; };
type Field = [tag: string, words: number[]];
/**
 * An unsigned invoice with exactly the fields given, a zero signature and a valid checksum: the decoder
 * checks the checksum, not the signature, so this is what a malformed or hostile invoice can look like.
 */
function rawInvoice(hrp: string, fields: Field[] = [], createdAt = 1_700_000_000) {
  const words = [...uint(createdAt, 7)];
  for (const [tag, data] of fields) words.push(CHARSET.indexOf(tag), data.length >> 5, data.length & 31, ...data);
  return bech32.encode(hrp, [...words, ...new Array(104).fill(0)], false);
}
const bytesField = (tag: string, bytes: Uint8Array): Field => [tag, bech32.toWords(bytes)];

describe("amounts", () => {
  it("reads every multiplier, rounding a millisat remainder up to the next sat", () => {
    const cases: [string, bigint, number][] = [
      ["lnbc1", 100_000_000_000n, 100_000_000], ["lnbc1m", 100_000_000n, 100_000], ["lnbc1u", 100_000n, 100], ["lnbc1n", 100n, 1],
      ["lnbc10p", 1n, 1], ["lnbc10010p", 1001n, 2], ["lnbc9n", 900n, 1], ["lnbc21000000", 21_000_000n * 100_000_000_000n, 2_100_000_000_000_000],
    ];
    for (const [hrp, msat, sat] of cases) expect(decodeBolt11(rawInvoice(hrp)), hrp).toMatchObject({ amountMsat: msat, amountSat: sat });
  });

  it("leaves the amount to the payer when there is none", () => {
    expect(decodeBolt11(rawInvoice("lnbc"))).toMatchObject({ amountMsat: null, amountSat: null });
  });

  it("refuses a pico amount that is not a whole millisat, and unknown multipliers", () => {
    expect(decodeBolt11(rawInvoice("lnbc11p"))).toBeNull();
    expect(decodeBolt11(rawInvoice("lnbc1x"))).toBeNull();
    expect(decodeBolt11(rawInvoice("lnbcm"))).toBeNull();
  });

  it("round-trips amounts and descriptions of signed invoices", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.string({ minLength: 1, maxLength: 60 }).filter(s => s.trim() === s && s.length > 0), (msat, description) => {
      const invoice = decodeBolt11(testInvoice({ msat, description }))!;
      expect(invoice.amountMsat).toBe(msat);
      expect(invoice.amountSat).toBe(Number((msat + 999n) / 1000n));
      expect(invoice.description).toBe(description);
    }), { numRuns: 100 });
  });
});

describe("networks and prefixes", () => {
  it("maps each chain's prefix, signet before testnet", () => {
    expect(decodeBolt11(rawInvoice("lnbc"))!.network).toBe("bitcoin");
    expect(decodeBolt11(rawInvoice("lntb20m"))!.network).toBe("testnet");
    expect(decodeBolt11(rawInvoice("lntbs20m"))!.network).toBe("signet");
    expect(decodeBolt11(rawInvoice("lnbcrt1u"))!.network).toBe("regtest");
  });

  it("refuses other chains, other prefixes and a separator too early", () => {
    for (const hrp of ["lnltc", "lnsb", "lightning", "bc", "lnbcrtx"]) expect(decodeBolt11(rawInvoice(hrp)), hrp).toBeNull();
    expect(decodeBolt11(`ln1${"q".repeat(200)}`)).toBeNull();
    expect(decodeBolt11("")).toBeNull();
  });
});

describe("the data part", () => {
  it("refuses characters outside the bech32 alphabet, a broken checksum, and too little data", () => {
    const good = rawInvoice("lnbc1u");
    expect(decodeBolt11(good)).not.toBeNull();
    expect(decodeBolt11(`${good.slice(0, -1)}b`)).toBeNull();
    expect(decodeBolt11(`${good.slice(0, -1)}${good.at(-1) === "q" ? "p" : "q"}`)).toBeNull();
    // Timestamp + signature + checksum is the minimum: one word short is refused.
    const minimal = bech32.encode("lnbc1u", new Array(7 + 104).fill(0), false);
    expect(decodeBolt11(minimal)).toMatchObject({ createdAt: 0, expiresAt: 3600 });
    const short = bech32.encode("lnbc1u", new Array(7 + 103).fill(0), false);
    expect(decodeBolt11(short)).toBeNull();
  });

  it("refuses a field that claims more data than there is", () => {
    // A `d` field declaring 127 words with only 3 before the signature: it may not read into the signature.
    const words = [...uint(1_700_000_000, 7), CHARSET.indexOf("d"), 3, 31, 1, 2, 3];
    expect(decodeBolt11(bech32.encode("lnbc1u", [...words, ...new Array(104).fill(0)], false))).toBeNull();
  });

  it("skips unknown tags and hash fields of the wrong length", () => {
    const hash = new Uint8Array(32).fill(0xab);
    const invoice = decodeBolt11(rawInvoice("lnbc1u", [
      ["q", [1, 2, 3]], bytesField("p", hash.subarray(0, 31)), bytesField("h", new Uint8Array(33)), bytesField("d", new TextEncoder().encode("coffee")),
    ]))!;
    expect(invoice).toMatchObject({ description: "coffee", paymentHash: undefined, descriptionHash: undefined });
    const both = decodeBolt11(rawInvoice("lnbc1u", [bytesField("p", hash), bytesField("h", hash)]))!;
    expect(both.paymentHash).toBe("ab".repeat(32));
    expect(both.descriptionHash).toBe("ab".repeat(32));
  });

  it("reads the expiry field, zero included, and uses an hour when there is none", () => {
    expect(decodeBolt11(rawInvoice("lnbc1u", [["x", []]], 1000))).toMatchObject({ createdAt: 1000, expiresAt: 1000 });
    expect(decodeBolt11(rawInvoice("lnbc1u", [["x", uint(604_800)]], 1000))!.expiresAt).toBe(1000 + 604_800);
    expect(decodeBolt11(rawInvoice("lnbc1u", [], 1000))!.expiresAt).toBe(1000 + 3600);
  });

  it("drops a blank description and survives one that is not UTF-8", () => {
    expect(decodeBolt11(rawInvoice("lnbc1u", [bytesField("d", new TextEncoder().encode("   \n"))]))!.description).toBeUndefined();
    expect(decodeBolt11(rawInvoice("lnbc1u", [bytesField("d", Uint8Array.of(0xff, 0xfe, 0x41))]))!.description).toBe("\ufffd\ufffdA");
  });

  it("takes the last of two description fields", () => {
    const invoice = decodeBolt11(rawInvoice("lnbc1u", [bytesField("d", new TextEncoder().encode("first")), bytesField("d", new TextEncoder().encode("second"))]))!;
    expect(invoice.description).toBe("second");
  });
});

describe("size limit", () => {
  /** An invoice padded with unknown fields to exactly `length` characters. */
  function ofLength(length: number) {
    const base = rawInvoice("lnbc1u").length;
    const fields: Field[] = [];
    for (let rest = length - base; rest > 0;) {
      const size = Math.min(rest - 3, 1000);
      fields.push(["q", new Array(size).fill(0)]);
      rest -= size + 3;
    }
    const invoice = rawInvoice("lnbc1u", fields);
    expect(invoice).toHaveLength(length);
    return invoice;
  }
  it("reads an invoice of exactly 7089 characters and refuses one more", () => {
    expect(decodeBolt11(ofLength(7089))).not.toBeNull();
    expect(decodeBolt11(ofLength(7090))).toBeNull();
    // The limit applies after the scheme and surrounding whitespace are removed.
    expect(decodeBolt11(`  lightning:${ofLength(7089)}\n`)).not.toBeNull();
  });
});

describe("finding an invoice in a message", () => {
  it("is null when something looks like an invoice but does not decode", () => {
    const broken = SPEC_INVOICE.slice(0, -1) + (SPEC_INVOICE.at(-1) === "h" ? "q" : "h");
    expect(findBolt11(`pay ${broken} please`)).toBeNull();
    expect(findBolt11(`pay lightning:${SPEC_INVOICE}.`)).toMatchObject({ invoice: { amountSat: 250_000 }, rest: "pay ." });
  });

  it("never throws on arbitrary text, and what it finds decodes on its own", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 20 }), (noise, before) => {
      for (const text of [noise, `${before}${SPEC_INVOICE.slice(0, noise.length % SPEC_INVOICE.length)}${noise}`]) {
        expect(() => decodeBolt11(text)).not.toThrow();
        const found = findBolt11(text);
        if (found) expect(decodeBolt11(found.invoice.invoice)).toEqual(found.invoice);
      }
    }), { numRuns: 300 });
  });
});
