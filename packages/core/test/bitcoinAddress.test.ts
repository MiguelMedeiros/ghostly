import { describe, expect, it } from "vitest";
import { ONCHAIN_PROVIDER, isBitcoinAddress, validatePaymentTarget, type BitcoinNetwork } from "../src";
// covers: core.bitcoin-address, payments.targets

// BIP 173 / BIP 350 test vectors, and well-known base58 addresses.
const VALID: [string, BitcoinNetwork[]][] = [
  ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", ["bitcoin"]],
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", ["bitcoin"]],
  ["bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", ["bitcoin"]],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", ["bitcoin"]],
  ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", ["bitcoin"]],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", ["testnet", "signet", "mutinynet"]],
  ["tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", ["testnet", "signet", "mutinynet"]],
  ["bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", ["regtest"]],
  ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", ["bitcoin"]],
  ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", ["bitcoin"]],
  ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", ["testnet", "signet", "regtest", "mutinynet"]],
  ["2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc", ["testnet", "signet", "regtest", "mutinynet"]],
];
const INVALID = [
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // bad checksum
  "BC1QW508D6QEJXTDG4Y5R3ZARVARy0C5XW7KV8F3T4", // mixed case
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", // v1 with a bech32 (not bech32m) checksum
  "bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj", // v2 with a bech32 checksum (valid before BIP 350)
  "bc1qr508d6qejxtdg4y5r3zarvaryv98gj9p", // v0 program of 16 bytes
  "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", // base58 checksum
  "not an address",
  "",
];

describe("Bitcoin addresses", () => {
  it("accepts every valid address on its networks, and only there", () => {
    for (const [address, networks] of VALID) {
      for (const network of ["bitcoin", "testnet", "signet", "regtest", "mutinynet"] as BitcoinNetwork[]) {
        expect(isBitcoinAddress(address, network), `${address} on ${network}`).toBe(networks.includes(network));
      }
    }
  });
  it("refuses bad checksums, mixed case, the wrong checksum for a witness version and bad lengths", () => {
    for (const address of INVALID) expect(isBitcoinAddress(address, "bitcoin"), address).toBe(false);
    expect(isBitcoinAddress(42, "bitcoin")).toBe(false);
  });
});

describe("the bitcoin payment method", () => {
  const target = (address: string, network = "bitcoin") => ({ method: "bitcoin", network, provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });
  it("validates the address against the target's network", () => {
    expect(validatePaymentTarget(target("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"))).toMatchObject({ method: "bitcoin", network: "bitcoin" });
    expect(validatePaymentTarget(target("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", "regtest"))).toMatchObject({ network: "regtest" });
    expect(() => validatePaymentTarget(target("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"))).toThrow("not a Bitcoin address");
    expect(() => validatePaymentTarget(target("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "signet"))).toThrow("not a signet address");
  });
  it("refuses another asset, unit, network family or provider", () => {
    const ok = target("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    for (const bad of [{ asset: "USDT" }, { unit: "token-base" }, { network: "ethereum" }, { network: "cashu-test" }, { provider: "https://example.com" }]) {
      expect(() => validatePaymentTarget({ ...ok, ...bad }), JSON.stringify(bad)).toThrow();
    }
    expect(() => validatePaymentTarget({ ...ok, expiresAt: Date.now() - 1 })).toThrow("expired");
  });
});
