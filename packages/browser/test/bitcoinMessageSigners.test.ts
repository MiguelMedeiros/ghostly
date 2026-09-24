import { verifyBitcoinMessage, type BitcoinProofNetwork } from "@ghostly/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { RawWitness, utils } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { guidesFor } from "../src/proofs/bitcoinWallets";
import { REGTEST, SIGNET, testBitcoinWallet, type TestNet, type TestScript } from "./helpers/bitcoinSign";
// covers: proofs.bitcoin

// Own BIP-322 signatures on test-network addresses, made by an independent signer (helpers/bitcoinSign.ts).

const sign = (kind: TestScript, net: TestNet, message: string) => {
  const wallet = testBitcoinWallet(kind, net);
  return { address: wallet.address, ...wallet.signBip322(message) };
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

const verify = (address: string, message: string, signature: string, network: BitcoinProofNetwork = "testnet") =>
  verifyBitcoinMessage({ address, message, signature, network });

describe("BIP-322 signatures from an independent signer, on test networks", () => {
  const message = '["ghostly-peer-proof",1,"a statement","ünïcødé ✓"]';
  for (const [name, net] of [["signet/testnet (tb)", SIGNET], ["regtest (bcrt)", REGTEST]] as const) {
    for (const kind of ["p2wpkh", "p2tr"] as const) {
      it(`${kind} on ${name}: simple and full`, () => {
        const s = sign(kind, net, message);
        expect(verify(s.address, message, s.simple!)).toEqual({ state: "valid", format: "bip322-simple", script: kind });
        expect(verify(s.address, message, s.full)).toEqual({ state: "valid", format: "bip322-full", script: kind });
        // Unprefixed (pre-1.0 wallets) reads as simple.
        expect(verify(s.address, message, s.simple!.slice(3))).toMatchObject({ state: "valid", format: "bip322-simple" });
      });
    }
    for (const kind of ["p2sh-p2wpkh", "p2pkh"] as const) {
      it(`${kind} on ${name}: full only`, () => {
        const s = sign(kind, net, message);
        expect(verify(s.address, message, s.full)).toEqual({ state: "valid", format: "bip322-full", script: kind });
        if (s.simple) expect(verify(s.address, message, s.simple)).toEqual({ state: "invalid", reason: expect.stringMatching(/full format/) });
      });
    }
  }

  it("refuses a signature for another address or another statement", () => {
    const a = sign("p2wpkh", SIGNET, message), b = sign("p2wpkh", SIGNET, message), t = sign("p2tr", SIGNET, message);
    expect(verify(b.address, message, a.simple!).state).toBe("invalid");
    expect(verify(t.address, message, a.simple!).state).toBe("invalid");
    expect(verify(a.address, message.replace("a statement", "another"), a.simple!).state).toBe("invalid");
    expect(verify(a.address, message.replace("a statement", "another"), a.full).state).toBe("invalid");
    expect(verify(t.address, `${message} `, t.simple!).state).toBe("invalid");
  });

  it("does not accept a test-network proof in Mainnet mode", () => {
    const s = sign("p2wpkh", SIGNET, message);
    expect(verify(s.address, message, s.simple!, "mainnet")).toEqual({ state: "invalid", reason: expect.stringMatching(/test-network/) });
  });

  it("refuses a high-S ECDSA signature (BIP-322 requires LOW_S)", () => {
    const s = sign("p2wpkh", SIGNET, message);
    const stack = RawWitness.decode(Buffer.from(s.simple!.slice(3), "base64"));
    const sig = secp256k1.Signature.fromBytes(stack[0].subarray(0, -1), "der");
    const high = new secp256k1.Signature(sig.r, secp256k1.Point.Fn.neg(sig.s)).toBytes("der");
    const tampered = `smp${b64(RawWitness.encode([utils.concatBytes(high, Uint8Array.of(1)), stack[1]]))}`;
    expect(verify(s.address, message, tampered)).toEqual({ state: "invalid", reason: expect.any(String) });
  });
});

describe("wallet guides", () => {
  it("offers, per address type, only wallets whose format Ghostly accepts for it", () => {
    for (const script of ["p2wpkh", "p2tr"] as const) expect(guidesFor(script).every(g => g.format === "bip322")).toBe(true);
    expect(guidesFor("p2pkh").map(g => g.id)).toEqual(expect.arrayContaining(["bitcoin-core", "electrum", "trezor", "sparrow"]));
    expect(guidesFor("p2sh").map(g => g.id)).toEqual(["other"]);
    expect(guidesFor("p2wsh")).toEqual([]);
  });
});
