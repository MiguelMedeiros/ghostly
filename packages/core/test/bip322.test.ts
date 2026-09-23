import { describe, expect, it } from "vitest";
import {
  bip322MessageHash, bip322ToSign, bip322ToSpend, decodeBitcoinAddress, encodeTx, txHash, verifyBitcoinMessage,
  type BitcoinMessageVerdict,
} from "../src";
import basic from "./fixtures/bip322/basic-test-vectors.json";
import generated from "./fixtures/bip322/generated-test-vectors.json";

// The official BIP-322 vectors, version 2.0.0 (bitcoin/bips@4061a54418f62a5a1ae44f4604e56373329bfad3),
// copied as they are into fixtures/bip322/. Their private keys are the BIP's public test keys; none is used here.

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const displayId = (b: Uint8Array) => hex(Uint8Array.from(b).reverse());
const verify = (address: string, message: string, signature: string) => verifyBitcoinMessage({ address, message, signature, network: "mainnet" });

/** The script types this verifier checks; the others must come back inconclusive, never valid. */
const CHECKED = new Set(["p2wpkh", "p2tr", "p2sh-p2wpkh", "p2pkh"]);
const SCRIPT: Record<string, string> = { p2wpkh: "p2wpkh", p2tr: "p2tr", "p2sh-p2wpkh": "p2sh-p2wpkh", p2pkh: "p2pkh" };

interface Vector { message: string; address: string; type: string; bip322_signatures: string[] }

describe("BIP-322 official vectors: hashes", () => {
  for (const v of basic.tx_hashes) {
    it(`message ${JSON.stringify(v.message)}`, () => {
      expect(hex(bip322MessageHash(v.message))).toBe(v.message_hash);
      const toSpend = bip322ToSpend(v.message, decodeBitcoinAddress(v.address, "mainnet").scriptPubKey);
      expect(displayId(txHash(toSpend))).toBe(v.to_spend_tx_hash);
      expect(displayId(txHash(bip322ToSign(toSpend)))).toBe(v.to_sign_tx_hash);
    });
  }
});

function expectVerdict(v: Vector, signature: string, result: BitcoinMessageVerdict) {
  if (CHECKED.has(v.type)) expect(result, `${v.type} ${signature.slice(0, 12)}`).toMatchObject({ state: "valid", script: SCRIPT[v.type] });
  else expect(result.state, `${v.type} must not pass as valid`).toBe("inconclusive");
}

describe("BIP-322 official vectors: valid signatures", () => {
  const groups: [string, Vector[]][] = [
    ["basic simple", basic.simple], ["generated simple", generated.simple], ["generated full", generated.full],
  ];
  for (const [name, vectors] of groups) {
    for (const v of vectors) {
      it(`${name}: ${v.type} ${v.address}`, () => {
        for (const signature of v.bip322_signatures) {
          const result = verify(v.address, v.message, signature);
          expectVerdict(v, signature, result);
          if (result.state === "valid") expect(result.format).toBe(signature.startsWith("ful") ? "bip322-full" : "bip322-simple");
        }
      });
    }
  }

  it("reads an unprefixed signature as simple (the BIP's backward-compatibility rule)", () => {
    const v = basic.simple.find(x => x.message === "No prefix fallback")!;
    expect(verify(v.address, v.message, v.bip322_signatures[0])).toEqual({ state: "valid", format: "bip322-simple", script: "p2tr" });
  });

  it("the same valid signatures fail for another message", () => {
    for (const v of [...basic.simple, ...generated.simple, ...generated.full].filter(x => CHECKED.has(x.type)))
      for (const signature of v.bip322_signatures)
        expect(verify(v.address, `${v.message}!`, signature).state, `${v.type} ${v.address}`).toBe("invalid");
  });

  it("never accepts a proof of funds", () => {
    for (const v of generated.proof_of_funds)
      for (const signature of v.bip322_signatures) expect(verify(v.address, v.message, signature).state).toBe("inconclusive");
  });
});

describe("BIP-322 official vectors: errors", () => {
  for (const v of [...basic.error, ...generated.error]) {
    it(v.description, () => {
      const result = verify(v.address, v.message, v.signature);
      // Where the script is one this verifier checks, the failure is certain: invalid, not merely inconclusive.
      const type = decodeBitcoinAddress(v.address, "mainnet").type;
      if (type === "p2wpkh" || type === "p2tr" || type === "p2pkh") expect(result.state).toBe("invalid");
      else expect(result.state).not.toBe("valid");
    });
  }
});

describe("simple and full agree", () => {
  it("a simple P2WPKH witness wrapped as the full transaction verifies as full", () => {
    const v = basic.simple.find(x => x.message === "Hello World")!;
    const toSpend = bip322ToSpend(v.message, decodeBitcoinAddress(v.address, "mainnet").scriptPubKey);
    const witness = verify(v.address, v.message, v.bip322_signatures[0]).state === "valid" ? v.bip322_signatures[0] : "";
    const stack = parseWitness(Buffer.from(witness.slice(3), "base64"));
    const full = "ful" + Buffer.from(encodeTx(bip322ToSign(toSpend, stack))).toString("base64");
    expect(verify(v.address, v.message, full)).toEqual({ state: "valid", format: "bip322-full", script: "p2wpkh" });
  });
});

function parseWitness(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 1;
  for (let i = 0; i < bytes[0]; i++) { out.push(bytes.subarray(at + 1, at + 1 + bytes[at])); at += 1 + bytes[at]; }
  return out;
}

describe("networks", () => {
  const v = basic.simple[1];
  it("a mainnet address is refused in Testnet mode, and says why", () => {
    const result = verifyBitcoinMessage({ address: v.address, message: v.message, signature: v.bip322_signatures[0], network: "testnet" });
    expect(result).toEqual({ state: "invalid", reason: expect.stringMatching(/mainnet address/) });
  });
  it("test-network addresses are refused in Mainnet mode", () => {
    for (const address of ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"])
      expect(verify(address, "", "smpAA==")).toEqual({ state: "invalid", reason: expect.stringMatching(/test-network/) });
  });
  it("decodes the test networks' prefixes", () => {
    expect(decodeBitcoinAddress("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", "testnet").type).toBe("p2wpkh");
    expect(decodeBitcoinAddress("tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "testnet").type).toBe("p2tr");
    expect(decodeBitcoinAddress("2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc", "testnet").type).toBe("p2sh");
    expect(decodeBitcoinAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "testnet").type).toBe("p2pkh");
  });
});
