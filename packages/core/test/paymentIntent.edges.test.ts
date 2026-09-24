import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  EVM_TEST_CHAINS, ONCHAIN_PROVIDER, SEPOLIA_TEST_USDT, assertTokenUnits, assertWholeSats, formatPaymentAmount, parsePaymentAmount, validatePaymentTarget,
} from "../src/paymentIntent";

// covers: payments.amounts, payments.targets

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ark = { method: "arkade", network: "bitcoin", provider: "https://arkade.example.com", asset: "BTC", unit: "sat", address: "ark1qexample", expiresAt: NOW + 60_000 };
const localUsdt = { method: "usdt", network: "evm-local", provider: "http://127.0.0.1:8545", asset: "TEST-USDT", unit: "token-base", chainId: EVM_TEST_CHAINS["evm-local"],
  token: SEPOLIA_TEST_USDT, decimals: 18, address: `0x${"3".repeat(40)}`, issuedAt: NOW, expiresAt: NOW + 60_000 };

describe("amounts at the wallet limit", () => {
  it("accepts exactly the largest safe amount and refuses one unit more, whatever the decimals", () => {
    expect(parsePaymentAmount("9007199254740991", 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parsePaymentAmount("9007199254740992", 0)).toThrow("Amount exceeds the wallet limit");
    expect(parsePaymentAmount("9007199254.740991", 6)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parsePaymentAmount("9007199254.740992", 6)).toThrow("Amount exceeds the wallet limit");
    expect(parsePaymentAmount("0", 18)).toBe(0);
    expect(() => parsePaymentAmount("1.0000000", 6)).toThrow("Use at most 6 decimal places");
  });

  it("round-trips every amount it accepts, with trailing zeros dropped", () => {
    fc.assert(fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 0, max: 18 }), (units, decimals) => {
      const text = formatPaymentAmount(units, decimals);
      expect(text).not.toMatch(/\.$|\.\d*0$|e/);
      expect(parsePaymentAmount(text, decimals)).toBe(units);
    }), { numRuns: 300 });
  });

  it("never throws anything but its own messages on arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.integer({ min: -2, max: 20 }), (value, decimals) => {
      try { expect(Number.isSafeInteger(parsePaymentAmount(value, decimals))).toBe(true); }
      catch (e) { expect((e as Error).message).toMatch(/^(Enter a valid amount|Use at most \d+ decimal places|Amount exceeds the wallet limit)$/); }
    }), { numRuns: 300 });
  });

  it("accepts the whole supply of sats and any positive safe token amount", () => {
    expect(() => assertWholeSats(2_100_000_000_000_000)).not.toThrow();
    expect(() => assertTokenUnits(1)).not.toThrow();
    expect(() => assertTokenUnits(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

describe("payment targets at their boundaries", () => {
  it("accepts an expiry of exactly a day, and a token request issued up to 30 s ahead", () => {
    expect(validatePaymentTarget({ ...ark, expiresAt: NOW + DAY }, NOW).expiresAt).toBe(NOW + DAY);
    expect(() => validatePaymentTarget({ ...ark, expiresAt: NOW + DAY + 1 }, NOW)).toThrow("Payment request expired or has an invalid expiry");
    expect(validatePaymentTarget({ ...localUsdt, issuedAt: NOW + 30_000 }, NOW).issuedAt).toBe(NOW + 30_000);
    expect(() => validatePaymentTarget({ ...localUsdt, issuedAt: NOW + 30_001 }, NOW)).toThrow("Invalid token request time");
  });

  it("accepts a local test chain's token and keeps its metadata, dropping it for other methods", () => {
    expect(validatePaymentTarget(localUsdt, NOW)).toEqual({ ...localUsdt });
    expect(validatePaymentTarget({ ...ark, chainId: 1, token: "x", decimals: 6, issuedAt: NOW }, NOW)).toEqual(ark);
  });

  it("refuses a token request without a token, with a real chain's id, or a zero recipient", () => {
    const { token: _token, ...noToken } = localUsdt;
    expect(() => validatePaymentTarget(noToken, NOW)).toThrow("Invalid token, recipient or EVM network");
    expect(() => validatePaymentTarget({ ...localUsdt, chainId: 1 }, NOW)).toThrow("Token metadata does not match the network");
    expect(() => validatePaymentTarget({ ...localUsdt, decimals: undefined }, NOW)).toThrow("Token metadata does not match the network");
    expect(() => validatePaymentTarget({ ...localUsdt, address: `0x${"0".repeat(40)}` }, NOW)).toThrow("Invalid token, recipient or EVM network");
    expect(() => validatePaymentTarget({ ...localUsdt, network: "bitcoin" }, NOW)).toThrow("Invalid token, recipient or EVM network");
  });

  it("keeps Bark to the networks Second runs, and Ark/Cashu off testnet", () => {
    for (const network of ["bitcoin", "signet", "regtest"]) expect(validatePaymentTarget({ ...ark, method: "bark", network }, NOW).network).toBe(network);
    for (const network of ["mutinynet", "cashu-test"]) expect(() => validatePaymentTarget({ ...ark, method: "bark", network }, NOW)).toThrow("Unsupported Bark network");
    expect(() => validatePaymentTarget({ ...ark, network: "testnet" }, NOW)).toThrow("Unsupported payment method, asset or network");
  });

  it("refuses an on-chain target naming a service, or an address of another network", () => {
    const onchain = { method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: "bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", expiresAt: NOW + 60_000 };
    expect(validatePaymentTarget(onchain, NOW)).toEqual(onchain);
    expect(() => validatePaymentTarget({ ...onchain, provider: "https://mempool.example.com" }, NOW)).toThrow("Unsupported payment method, asset or network");
    expect(() => validatePaymentTarget({ ...onchain, network: "signet" }, NOW)).toThrow("That is not a signet address");
  });

  it("refuses a provider that is not a URL, and one longer than 512 characters", () => {
    expect(() => validatePaymentTarget({ ...ark, provider: "arkade" }, NOW)).toThrow();
    expect(() => validatePaymentTarget({ ...ark, provider: 7 }, NOW)).toThrow("Invalid payment destination");
    const long = `https://arkade.example.com/${"p".repeat(512 - 27)}`;
    expect(long).toHaveLength(512);
    expect(validatePaymentTarget({ ...ark, provider: long }, NOW).provider).toBe(long);
    expect(() => validatePaymentTarget({ ...ark, provider: `${long}p` }, NOW)).toThrow("Invalid payment destination");
  });
});
