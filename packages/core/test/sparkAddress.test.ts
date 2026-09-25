import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bech32m } from "@scure/base";
import { SPARK_PROVIDER, isSparkAddress, sparkAddressKind, sparkInvoiceDetails, sparkNetworkOf } from "../src/sparkAddress";
import { validatePaymentTarget } from "../src/paymentIntent";
import { decodeControl } from "../src/frames";

// covers: payments.targets, payments.spark.offer

/** Made by the Breez SDK on Breez's regtest (a wallet's address, and an invoice of 1234 sats from it). */
const ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";
const INVOICE = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkzg5qsqgjzqq6p4sscrm8avymnelqhzrus7wz5ptswfhkyef6qcydm9xh65rzyqcg6gy35sxa3w5e20exjmr8xhyl96u3cxqk9ttgwes2xkfepzpp5nmw3zu5aczluq5t2fly3venjcv3cn9fvmtjgwcaae4fw2rqw4fy0nwd082rg0zclp2";
/** The same payload under another prefix: what that network's wallet would show. */
const as = (hrp: string, address: string) => bech32m.encode(hrp, bech32m.decode(address as `${string}1${string}`, 1024).words, 1024);
const payload = (address: string) => bech32m.fromWords(bech32m.decode(address as `${string}1${string}`, 1024).words);
const encode = (hrp: string, bytes: Uint8Array) => bech32m.encode(hrp, bech32m.toWords(bytes), 1024);
const NOW = 1_800_000_000_000;
const target = (address: string, extra: Record<string, unknown> = {}) => ({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: NOW + 60_000, ...extra });

describe("Spark addresses", () => {
  it("tells a wallet's address from an invoice, on its own network only", () => {
    expect(sparkAddressKind(ADDRESS, "regtest")).toBe("address");
    expect(sparkAddressKind(INVOICE, "regtest")).toBe("invoice");
    expect(sparkAddressKind(ADDRESS, "bitcoin")).toBeUndefined();
    const mainnet = as("spark", ADDRESS);
    expect(mainnet.startsWith("spark1")).toBe(true);
    expect(sparkAddressKind(mainnet, "bitcoin")).toBe("address");
    expect(sparkAddressKind(mainnet, "regtest")).toBeUndefined();
    expect(sparkNetworkOf(mainnet)).toBe("bitcoin");
    expect(sparkNetworkOf(INVOICE)).toBe("regtest");
    expect(sparkNetworkOf("bcrt1qexample")).toBeUndefined();
  });

  it("refuses Spark's other networks, old prefixes, upper case, a broken checksum and other payloads", () => {
    for (const hrp of ["sparkt", "sparks", "sparkl", "sprt", "sp"]) expect(sparkNetworkOf(as(hrp, ADDRESS))).toBeUndefined();
    expect(isSparkAddress(ADDRESS.toUpperCase(), "regtest")).toBe(false);
    expect(isSparkAddress(`${ADDRESS.slice(0, -1)}${ADDRESS.endsWith("q") ? "p" : "q"}`, "regtest")).toBe(false);
    const key = payload(ADDRESS);
    // Not a compressed key, a key of the wrong length, and something unknown after the key.
    expect(isSparkAddress(encode("sparkrt", Uint8Array.from([0x0a, 0x21, 0x04, ...key.slice(3)])), "regtest")).toBe(false);
    expect(isSparkAddress(encode("sparkrt", key.slice(0, 34)), "regtest")).toBe(false);
    expect(isSparkAddress(encode("sparkrt", Uint8Array.from([...key, 0x1a, 0x00])), "regtest")).toBe(false);
    // A Taproot address is bech32m too, but not a Spark one.
    expect(isSparkAddress("bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6", "regtest")).toBe(false);
    expect(isSparkAddress(`sparkrt1${"q".repeat(1100)}`, "regtest")).toBe(false);
    expect(isSparkAddress(42, "regtest")).toBe(false);
  });

  it("never throws on arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (text) => {
      expect(typeof isSparkAddress(text, "regtest")).toBe("boolean");
      expect(typeof isSparkAddress(`sparkrt1${text}`, "bitcoin")).toBe("boolean");
    }), { numRuns: 300 });
  });
});

describe("a Spark payment target", () => {
  it("is an address or an invoice of its network, in sats, from no provider in particular", () => {
    expect(validatePaymentTarget(target(ADDRESS), NOW)).toEqual(target(ADDRESS));
    expect(validatePaymentTarget(target(INVOICE), NOW).address).toBe(INVOICE);
    expect(validatePaymentTarget(target(as("spark", ADDRESS), { network: "bitcoin" }), NOW).network).toBe("bitcoin");
  });

  it("refuses another network, asset, unit or provider, and an address of another network", () => {
    expect(() => validatePaymentTarget(target(ADDRESS, { network: "signet" }), NOW)).toThrow("Unsupported payment method, asset or network");
    expect(() => validatePaymentTarget(target(ADDRESS, { asset: "USDT" }), NOW)).toThrow("Unsupported payment method, asset or network");
    expect(() => validatePaymentTarget(target(ADDRESS, { unit: "token-base" }), NOW)).toThrow("Unsupported payment method, asset or network");
    expect(() => validatePaymentTarget(target(ADDRESS, { provider: "https://spark.example" }), NOW)).toThrow("Unsupported payment method, asset or network");
    expect(() => validatePaymentTarget(target(ADDRESS, { network: "bitcoin" }), NOW)).toThrow("That is not a Spark address on Bitcoin");
    expect(() => validatePaymentTarget(target(as("spark", ADDRESS)), NOW)).toThrow("That is not a Spark address on regtest");
    expect(() => validatePaymentTarget(target("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"), NOW)).toThrow("That is not a Spark address");
    expect(() => validatePaymentTarget(target(ADDRESS, { expiresAt: NOW - 1 }), NOW)).toThrow("expired");
  });

  it("keeps nothing but the target's own fields", () => {
    expect(validatePaymentTarget(target(ADDRESS, { chainId: 1, token: "x", extra: true }), NOW)).toEqual(target(ADDRESS));
  });
});

describe("asking to pay on Spark", () => {
  it("is a pay-ask a contact's app can read", () => {
    expect(decodeControl(JSON.stringify({ t: "pay-ask", id: "a".repeat(16), ts: 1, v: "21", u: "sat", m: "spark" }))).toMatchObject({ t: "pay-ask", m: "spark" });
    expect(decodeControl(JSON.stringify({ t: "pay-ask", id: "a".repeat(16), ts: 1, v: "21", u: "sat", m: "sparks" }))).toBeNull();
  });
});

describe("what a Spark invoice asks for", () => {
  it("reads the amount, memo and expiry of a real invoice", () => {
    expect(sparkInvoiceDetails(INVOICE, "regtest")).toEqual({ token: false, amount: 1234, memo: "probe", expiresAt: 1790298717000 });
  });
  it("is nothing for an address, another network, or a malformed body", () => {
    expect(sparkInvoiceDetails(ADDRESS, "regtest")).toBeUndefined();
    expect(sparkInvoiceDetails(INVOICE, "bitcoin")).toBeUndefined();
    const key = payload(ADDRESS);
    expect(sparkInvoiceDetails(encode("sparkrt", Uint8Array.from([...key, 0x12, 0x05, 0x08])), "regtest")).toBeUndefined();
    // An invoice with no amount: the payer chooses.
    expect(sparkInvoiceDetails(encode("sparkrt", Uint8Array.from([...key, 0x12, 0x02, 0x08, 0x01])), "regtest")).toEqual({ token: false });
    // A tokens invoice is told apart.
    expect(sparkInvoiceDetails(encode("sparkrt", Uint8Array.from([...key, 0x12, 0x04, 0x1a, 0x02, 0x08, 0x05])), "regtest")).toEqual({ token: true });
  });
  it("never throws on arbitrary bytes after the key", () => {
    const key = payload(ADDRESS);
    fc.assert(fc.property(fc.uint8Array({ maxLength: 120 }), (tail) => {
      const text = encode("sparkrt", Uint8Array.from([...key, 0x12, tail.length & 0x7f, ...tail]));
      const details = sparkInvoiceDetails(text, "regtest");
      expect(details === undefined || typeof details.token === "boolean").toBe(true);
    }), { numRuns: 300 });
  });
});
