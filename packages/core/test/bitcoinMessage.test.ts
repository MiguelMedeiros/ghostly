import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { concatBytes, hash160, legacyMessageHash, toBase64, verifyBitcoinMessage } from "../src";
import core from "./fixtures/bitcoin-core-signmessage.json";

const testnet = (address: string, message: string, signature: string) => verifyBitcoinMessage({ address, message, signature, network: "testnet" });

describe("legacy signmessage", () => {
  it("accepts Bitcoin Core's own signatures (regtest, P2PKH)", () => {
    for (const v of core.legacy) expect(testnet(v.address, v.message, v.signature)).toEqual({ state: "valid", format: "legacy", script: "p2pkh" });
  });

  it("accepts Bitcoin Core's published mainnet example", () => {
    // src/test/util_tests.cpp, message_verify
    expect(verifyBitcoinMessage({ network: "mainnet", address: "15CRxFdyRpGZLW9w8HnHvVduizdL5jKNbs", message: "Trust no one",
      signature: "IPojfrX2dfPnH26UegfbGQQLrdK844DlHq5157/P6h57WyuS/Qsl+h/WSVGDF4MUi4rWSswW38oimDYfNNUBUOk=" }).state).toBe("valid");
  });

  it("refuses another message, another address, or a tampered signature", () => {
    const [a, b] = core.legacy;
    expect(testnet(a.address, `${a.message} `, a.signature).state).toBe("invalid");
    expect(testnet(b.address, a.message, a.signature).state).toBe("invalid");
    const bytes = Buffer.from(a.signature, "base64");
    bytes[40] ^= 1;
    expect(testnet(a.address, a.message, bytes.toString("base64")).state).toBe("invalid");
  });

  it("is only for P2PKH: a legacy signature for a SegWit address is refused, pointing to BIP-322", () => {
    const [a] = core.legacy;
    const result = testnet("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", a.message, a.signature);
    expect(result).toEqual({ state: "invalid", reason: expect.stringMatching(/BIP-322/) });
  });

  it("refuses a BIP 137 SegWit header on a P2PKH address", () => {
    const [a] = core.legacy;
    const bytes = Buffer.from(a.signature, "base64");
    bytes[0] += 8; // compressed P2PKH 31-34 → P2SH-P2WPKH 35-38
    expect(testnet(a.address, a.message, bytes.toString("base64")).state).toBe("invalid");
  });

  it("recovers compressed and uncompressed keys (fresh test keys)", () => {
    const base58 = createBase58check(sha256);
    for (const compressed of [true, false]) {
      const secret = secp256k1.utils.randomSecretKey();
      const address = base58.encode(concatBytes(Uint8Array.of(0x6f), hash160(secp256k1.getPublicKey(secret, compressed))));
      const message = "a fresh key";
      const sig = secp256k1.sign(legacyMessageHash(message), secret, { prehash: false, format: "recovered" });
      const header = 27 + sig[0] + (compressed ? 4 : 0);
      const signature = toBase64(concatBytes(Uint8Array.of(header), sig.subarray(1)));
      expect(testnet(address, message, signature)).toEqual({ state: "valid", format: "legacy", script: "p2pkh" });
      // The same signature with the other compression flag names another address.
      const flipped = toBase64(concatBytes(Uint8Array.of(compressed ? header - 4 : header + 4), sig.subarray(1)));
      expect(testnet(address, message, flipped).state).toBe("invalid");
    }
  });
});

describe("input handling", () => {
  it("ignores whitespace pasted around or inside a signature", () => {
    const [a] = core.legacy;
    const wrapped = `  ${a.signature.slice(0, 40)}\n${a.signature.slice(40)}\n`;
    expect(testnet(`${a.address} `, a.message, wrapped).state).toBe("valid");
  });
  it("says what is wrong instead of throwing", () => {
    expect(testnet("not an address", "m", "AAAA")).toEqual({ state: "invalid", reason: expect.any(String) });
    expect(testnet(core.legacy[0].address, "m", "")).toEqual({ state: "invalid", reason: "The signature is empty" });
    expect(testnet(core.legacy[0].address, "m", "x".repeat(20000)).state).toBe("invalid");
  });
});
