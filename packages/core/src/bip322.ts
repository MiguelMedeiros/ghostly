import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { base64 } from "@scure/base";
import { bytesEqual, concatBytes, utf8Encode } from "./bytes";
import {
  type BitcoinAddressInfo, type Tx, decodeTx, decodeWitness, encodeTx, hash160, sha256d, txHash, u32, u64, varBytes,
} from "./bitcoinScript";

/**
 * BIP-322 "Generic Signed Message Format", verification only, pinned to **version 2.0.0** of the BIP
 * (bitcoin/bips commit 4061a54418f62a5a1ae44f4604e56373329bfad3, 2026-06-05), whose official test vectors
 * are in packages/core/test/fixtures/bip322/.
 *
 * Without a full script interpreter, this verifier checks the scripts it understands and says
 * "inconclusive" for the rest, as the BIP allows:
 *
 *   - P2WPKH  (bc1q…, 42 chars)  simple and full
 *   - P2TR    (bc1p…) key path   simple and full
 *   - P2SH-P2WPKH (3…)           full only: the simple format is for native SegWit
 *   - P2PKH   (1…)               full only
 *
 * Multisig and other scripts (P2WSH, bare P2SH, Taproot script path) and proofs of funds (`pof`) are
 * inconclusive, which a proof treats as not proven.
 */
export const BIP322_REVISION = "2.0.0 (bitcoin/bips@4061a54418f62a5a1ae44f4604e56373329bfad3)";

export type Bip322Format = "bip322-simple" | "bip322-full";
export type BitcoinProofScript = "p2pkh" | "p2wpkh" | "p2sh-p2wpkh" | "p2tr";
export interface Bip322Valid {
  format: Bip322Format;
  script: BitcoinProofScript;
  /** The full format's nLockTime and first nSequence, when the signer set them (BIP-322: "valid at time T and age S"). */
  lockTime?: number;
  sequence?: number;
}
export type BitcoinMessageVerdict =
  | ({ state: "valid" } & (Bip322Valid | { format: "legacy"; script: "p2pkh" }))
  /** Something checked failed: wrong key, message, address or a malformed signature. */
  | { state: "invalid"; reason: string }
  /** Maybe valid, but not something this verifier can check (a multisig, a time lock…). Never treat as proven. */
  | { state: "inconclusive"; reason: string };

/** A refusal while verifying; `inconclusive` for what cannot be checked rather than what failed. */
export class MessageRefusal extends Error {
  constructor(readonly state: "invalid" | "inconclusive", reason: string) { super(reason); }
}
const invalid = (reason: string) => new MessageRefusal("invalid", reason);
const inconclusive = (reason: string) => new MessageRefusal("inconclusive", reason);

const SIGHASH_DEFAULT = 0x00;
const SIGHASH_ALL = 0x01;
const OP_RETURN = Uint8Array.of(0x6a);
const ZERO32 = new Uint8Array(32);

export const bip322MessageHash = (message: string) => schnorr.utils.taggedHash("BIP0322-signed-message", utf8Encode(message));

/** The virtual transaction whose only output pays the address; `to_sign` spends it. */
export function bip322ToSpend(message: string, scriptPubKey: Uint8Array): Tx {
  return {
    version: 0, lockTime: 0,
    inputs: [{ txid: ZERO32, vout: 0xffffffff, sequence: 0, witness: [], scriptSig: concatBytes(Uint8Array.of(0x00, 0x20), bip322MessageHash(message)) }],
    outputs: [{ value: 0n, script: scriptPubKey }],
  };
}

/** `to_sign` with every field at the default the simple format assumes. */
export function bip322ToSign(toSpend: Tx, witness: Uint8Array[] = []): Tx {
  return {
    version: 0, lockTime: 0,
    inputs: [{ txid: txHash(toSpend), vout: 0, sequence: 0, scriptSig: new Uint8Array(0), witness }],
    outputs: [{ value: 0n, script: OP_RETURN }],
  };
}

/** Standard base64, whitespace (a pasted line break) ignored; missing padding tolerated. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const padded = clean.length % 4 === 0 ? clean : clean + "=".repeat(4 - (clean.length % 4));
  try { return base64.decode(padded); } catch { throw invalid("The signature is not valid base64"); }
}

// ---- Signature hashes, for the one input BIP-322 signs ----

/** BIP 143, for witness v0. `scriptCode` is the P2PKH script of the key. */
function sighashV0(tx: Tx, scriptCode: Uint8Array, hashType: number): Uint8Array {
  const input = tx.inputs[0];
  return sha256d(
    u32(tx.version),
    sha256d(...tx.inputs.map(i => concatBytes(i.txid, u32(i.vout)))),
    sha256d(...tx.inputs.map(i => u32(i.sequence))),
    input.txid, u32(input.vout), varBytes(scriptCode), u64(0n), u32(input.sequence),
    sha256d(...tx.outputs.map(o => concatBytes(u64(o.value), varBytes(o.script)))),
    u32(tx.lockTime), u32(hashType),
  );
}

/** BIP 341 key path, SIGHASH_DEFAULT or SIGHASH_ALL, no annex. */
function sighashV1(tx: Tx, scriptPubKey: Uint8Array, hashType: number): Uint8Array {
  const input = tx.inputs[0];
  return schnorr.utils.taggedHash("TapSighash", concatBytes(
    Uint8Array.of(0x00, hashType), u32(tx.version), u32(tx.lockTime),
    sha256(concatBytes(input.txid, u32(input.vout))),
    sha256(u64(0n)),
    sha256(varBytes(scriptPubKey)),
    sha256(u32(input.sequence)),
    sha256(concatBytes(...tx.outputs.map(o => concatBytes(u64(o.value), varBytes(o.script))))),
    Uint8Array.of(0x00), u32(0),
  ));
}

/** The original sighash, for P2PKH: the input's script replaced by the spent output's, the rest as is. */
function sighashLegacy(tx: Tx, scriptPubKey: Uint8Array, hashType: number): Uint8Array {
  const copy: Tx = { ...tx, inputs: tx.inputs.map((i, n) => ({ ...i, witness: [], scriptSig: n === 0 ? scriptPubKey : new Uint8Array(0) })) };
  return sha256d(encodeTx(copy, false), u32(hashType));
}

// ---- Script checks ----

/** A check that throws on malformed input (a point off the curve…) simply does not hold. */
function holds(check: () => boolean): boolean {
  try { return check(); } catch { return false; }
}

/** BIP 66 strict DER, the signature still carrying its sighash byte (Bitcoin Core's IsValidSignatureEncoding). */
function isStrictDer(sig: Uint8Array): boolean {
  if (sig.length < 9 || sig.length > 73 || sig[0] !== 0x30 || sig[1] !== sig.length - 3 || sig[2] !== 0x02) return false;
  const lenR = sig[3];
  if (lenR === 0 || 5 + lenR >= sig.length) return false;
  const lenS = sig[5 + lenR];
  if (lenS === 0 || lenR + lenS + 7 !== sig.length || sig[4 + lenR] !== 0x02) return false;
  if (sig[4] & 0x80 || (lenR > 1 && sig[4] === 0x00 && !(sig[5] & 0x80))) return false;
  if (sig[6 + lenR] & 0x80 || (lenS > 1 && sig[6 + lenR] === 0x00 && !(sig[7 + lenR] & 0x80))) return false;
  return true;
}

/** An ECDSA check with BIP-322's required rules: SIGHASH_ALL, strict DER, low S, a valid public key. */
function checkEcdsa(sigWithType: Uint8Array, pubkey: Uint8Array, sighash: (hashType: number) => Uint8Array, compressedOnly: boolean) {
  if (sigWithType.length === 0) throw invalid("The signature is empty");
  const valid = pubkey.length === 33 ? pubkey[0] === 0x02 || pubkey[0] === 0x03 : pubkey.length === 65 && !compressedOnly && pubkey[0] === 0x04;
  if (!valid) throw invalid("The signature carries a malformed public key");
  const hashType = sigWithType[sigWithType.length - 1];
  if (hashType !== SIGHASH_ALL) throw invalid("BIP-322 signatures must use SIGHASH_ALL");
  if (!isStrictDer(sigWithType)) throw invalid("The signature is not strictly DER-encoded");
  if (!holds(() => secp256k1.verify(sigWithType.subarray(0, -1), sighash(hashType), pubkey, { prehash: false, lowS: true, format: "der" })))
    throw invalid("The signature does not match this address and message");
}

const P2PKH_SCRIPT = (hash: Uint8Array) => concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac));

function checkP2wpkh(tx: Tx, program: Uint8Array) {
  const witness = tx.inputs[0].witness;
  if (witness.length !== 2) throw invalid("The signature does not match this address and message");
  const [sig, pubkey] = witness;
  if (pubkey.length !== 33 || !bytesEqual(hash160(pubkey), program)) throw invalid("The signature does not match this address and message");
  checkEcdsa(sig, pubkey, t => sighashV0(tx, P2PKH_SCRIPT(program), t), true);
}

/**
 * Whether a script-path witness commits to `outputKey` (BIP 341). When it does, a script runs that this
 * verifier cannot interpret; when it does not, the spend fails whatever the script says.
 */
function commitsToOutputKey(stack: Uint8Array[], outputKey: Uint8Array): boolean {
  const control = stack[stack.length - 1], script = stack[stack.length - 2];
  if (control.length < 33 || (control.length - 33) % 32 !== 0 || control.length > 33 + 32 * 128) return false;
  try {
    const internal = schnorr.utils.lift_x(bytesToNumberBE(control.subarray(1, 33)));
    let node = schnorr.utils.taggedHash("TapLeaf", Uint8Array.of(control[0] & 0xfe), varBytes(script));
    for (let at = 33; at < control.length; at += 32) {
      const sibling = control.subarray(at, at + 32);
      node = schnorr.utils.taggedHash("TapBranch", ...(compareBytes(node, sibling) < 0 ? [node, sibling] : [sibling, node]));
    }
    const tweak = bytesToNumberBE(schnorr.utils.taggedHash("TapTweak", control.subarray(1, 33), node));
    if (tweak >= secp256k1.Point.Fn.ORDER) return false;
    const q = internal.add(secp256k1.Point.BASE.multiply(tweak)).toAffine();
    return q.x === bytesToNumberBE(outputKey) && Number(q.y & 1n) === (control[0] & 1);
  } catch { return false; }
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function checkP2tr(tx: Tx, scriptPubKey: Uint8Array, outputKey: Uint8Array) {
  const witness = tx.inputs[0].witness;
  if (witness.length === 0) throw invalid("The signature does not match this address and message");
  if (witness.length > 1) {
    if (witness[witness.length - 1][0] === 0x50) throw inconclusive("Taproot signatures with an annex cannot be checked here");
    if (commitsToOutputKey(witness, outputKey)) throw inconclusive("Taproot script-path signatures cannot be checked here; sign with the address's key path");
    throw invalid("The signature does not match this address and message");
  }
  const sig = witness[0];
  let hashType: number;
  if (sig.length === 64) hashType = SIGHASH_DEFAULT;
  else if (sig.length === 65 && sig[64] === SIGHASH_ALL) hashType = SIGHASH_ALL;
  else if (sig.length === 65) throw invalid("BIP-322 signatures must use SIGHASH_ALL or SIGHASH_DEFAULT");
  else throw invalid("The signature does not match this address and message");
  if (!holds(() => schnorr.verify(sig.subarray(0, 64), sighashV1(tx, scriptPubKey, hashType), outputKey)))
    throw invalid("The signature does not match this address and message");
}

/** Exactly two direct pushes, as P2PKH's scriptSig: `<sig> <pubkey>` (MINIMALDATA holds for these sizes). */
function parseTwoPushes(script: Uint8Array): [Uint8Array, Uint8Array] {
  const items: Uint8Array[] = [];
  for (let at = 0; at < script.length;) {
    const n = script[at];
    if (n < 1 || n > 75 || at + 1 + n > script.length) throw invalid("The signature does not match this address and message");
    items.push(script.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  if (items.length !== 2) throw invalid("The signature does not match this address and message");
  return [items[0], items[1]];
}

function checkInput(tx: Tx, address: BitcoinAddressInfo): BitcoinProofScript {
  const input = tx.inputs[0];
  const { scriptPubKey, program } = address;
  switch (address.type) {
    case "p2wpkh":
      if (input.scriptSig.length) throw invalid("A native SegWit input carries no scriptSig");
      checkP2wpkh(tx, program);
      return "p2wpkh";
    case "p2tr":
      if (input.scriptSig.length) throw invalid("A native SegWit input carries no scriptSig");
      checkP2tr(tx, scriptPubKey, program);
      return "p2tr";
    case "p2pkh": {
      if (input.witness.length) throw invalid("A P2PKH input carries no witness");
      const [sig, pubkey] = parseTwoPushes(input.scriptSig);
      if (!bytesEqual(hash160(pubkey), program)) throw invalid("The signature does not match this address and message");
      checkEcdsa(sig, pubkey, t => sighashLegacy(tx, scriptPubKey, t), false);
      return "p2pkh";
    }
    case "p2sh": {
      // Only P2SH-P2WPKH: the scriptSig is exactly one push of `0 <20-byte key hash>`.
      const s = input.scriptSig;
      if (s.length !== 23 || s[0] !== 22 || s[1] !== 0x00 || s[2] !== 0x14)
        throw inconclusive("Only P2SH-wrapped single-key SegWit (P2SH-P2WPKH) can be checked here, not a multisig or other script");
      const redeem = s.subarray(1);
      if (!bytesEqual(hash160(redeem), program)) throw invalid("The signature does not match this address and message");
      checkP2wpkh(tx, redeem.subarray(2));
      return "p2sh-p2wpkh";
    }
    case "p2wsh":
      throw inconclusive("Script (P2WSH) addresses such as multisig cannot be checked here");
    default:
      throw inconclusive("This address type cannot be checked here");
  }
}

/** Checks a BIP-322 signature — `smp…`, `ful…`, or an unprefixed one read as simple — or throws a `MessageRefusal`. */
export function verifyBip322(address: BitcoinAddressInfo, message: string, signature: string): Bip322Valid {
  const text = signature.trim();
  if (text.startsWith("pof")) throw inconclusive("Proof-of-funds signatures are not accepted: Ghostly does not check balances or coins");
  const format: Bip322Format = text.startsWith("ful") ? "bip322-full" : "bip322-simple";
  // Before BIP-322 1.0.0 signatures had no prefix; the BIP lets a verifier read those as simple.
  const body = text.startsWith("smp") || text.startsWith("ful") ? text.slice(3) : text;
  const bytes = decodeBase64(body);
  if (bytes.length === 0) throw invalid("The signature is empty");
  const toSpend = bip322ToSpend(message, address.scriptPubKey);
  let toSign: Tx;
  if (format === "bip322-simple") {
    if (address.type === "p2pkh" || address.type === "p2sh")
      throw invalid("A simple BIP-322 signature is only for native SegWit addresses; this one needs the full format (ful…)");
    let witness: Uint8Array[];
    try { witness = decodeWitness(bytes); } catch { throw invalid("The signature is not a BIP-322 witness"); }
    toSign = bip322ToSign(toSpend, witness);
  } else {
    try { toSign = decodeTx(bytes); } catch { throw invalid("The signature is not a BIP-322 full transaction"); }
    if (toSign.inputs.length !== 1) throw inconclusive("Signatures over extra coins (proof of funds) are not accepted");
    const [input] = toSign.inputs;
    if (!bytesEqual(input.txid, txHash(toSpend)) || input.vout !== 0) throw invalid("The signature does not match this address and message");
    if (toSign.outputs.length !== 1 || toSign.outputs[0].value !== 0n || !bytesEqual(toSign.outputs[0].script, OP_RETURN))
      throw invalid("The signature is not a BIP-322 transaction");
    if (toSign.version !== 0 && toSign.version !== 2) throw inconclusive("Unknown BIP-322 transaction version");
  }
  const script = checkInput(toSign, address);
  const { lockTime } = toSign, { sequence } = toSign.inputs[0];
  // "Valid at time T and age S". For the single-key scripts checked here a time lock gates nothing but
  // when a real spend could confirm, not who holds the key, so it is reported rather than refused.
  return lockTime || sequence ? { format, script, lockTime, sequence } : { format, script };
}
