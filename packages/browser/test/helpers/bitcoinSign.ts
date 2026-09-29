import { bip322ToSpend, concatBytes, decodeAnyBitcoinAddress, encodeTx, legacyMessageHash, txHash } from "@ghostly/core";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { RawWitness, Transaction, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";

/**
 * A test Bitcoin wallet: a fresh random key, an address of one type, and message signatures made the
 * way wallets make them. BIP-322 goes through @scure/btc-signer, which computes its own sighashes, so it
 * is an independent signer for the verifier. Keys are never printed.
 */
export type TestScript = "p2wpkh" | "p2tr" | "p2sh-p2wpkh" | "p2pkh";
export const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export const SIGNET = { bech32: "tb", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export const MAINNET = { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
export type TestNet = typeof SIGNET;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const reverse = (b: Uint8Array) => Uint8Array.from(b).reverse();

export interface TestBitcoinWallet {
  address: string;
  /** BIP-322 `smp…` (native SegWit only) and `ful…`. */
  signBip322(message: string): { simple?: string; full: string };
  /** Legacy signmessage (P2PKH addresses). */
  signLegacy(message: string): string;
}

export function testBitcoinWallet(kind: TestScript, net: TestNet = SIGNET): TestBitcoinWallet {
  const secret = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(secret, true);
  const payment = kind === "p2wpkh" ? p2wpkh(pub, net) : kind === "p2tr" ? p2tr(schnorr.getPublicKey(secret), undefined, net)
    : kind === "p2sh-p2wpkh" ? p2sh(p2wpkh(pub, net), net) : p2pkh(pub, net);
  const address = payment.address!;
  return {
    address,
    signBip322(message) {
      const toSpend = bip322ToSpend(message, decodeAnyBitcoinAddress(address).scriptPubKey);
      const tx = new Transaction({ version: 0, allowUnknownOutputs: true });
      tx.addInput({
        txid: reverse(txHash(toSpend)), index: 0, sequence: 0,
        ...(kind === "p2pkh" ? { nonWitnessUtxo: encodeTx(toSpend) } : { witnessUtxo: { script: payment.script, amount: 0n } }),
        ...(kind === "p2sh-p2wpkh" ? { redeemScript: (payment as ReturnType<typeof p2sh>).redeemScript } : {}),
        ...(kind === "p2tr" ? { tapInternalKey: (payment as ReturnType<typeof p2tr>).tapInternalKey } : {}),
      });
      tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
      tx.sign(secret);
      tx.finalize();
      const witness = tx.getInput(0).finalScriptWitness;
      return { simple: witness && kind !== "p2sh-p2wpkh" ? `smp${b64(RawWitness.encode(witness))}` : undefined, full: `ful${b64(tx.extract())}` };
    },
    signLegacy(message) {
      const sig = secp256k1.sign(legacyMessageHash(message), secret, { prehash: false, format: "recovered" });
      return b64(concatBytes(Uint8Array.of(31 + sig[0]), sig.subarray(1)));
    },
  };
}
