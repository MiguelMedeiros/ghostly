import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, bech32m, createBase58check } from "@scure/base";
import {
  bip322ToSign, bip322ToSpend, concatBytes, decodeBitcoinAddress, decodeTx, decodeWitness, encodeTx, encodeWitness, hash160, sha256d, toBase64,
  verifyBitcoinMessage, type BitcoinMessageVerdict, type BitcoinProofNetwork, type Tx,
} from "../src";
import basic from "./fixtures/bip322/basic-test-vectors.json";
import generated from "./fixtures/bip322/generated-test-vectors.json";

// Negative cases are the official BIP-322 v2.0.0 vectors (fixtures/bip322/) with one thing changed, or
// fresh keys signed here with the BIP-143 / BIP-341 / legacy sighash written out from the BIPs.

const N = secp256k1.Point.Fn.ORDER;
const G = secp256k1.Point.BASE;
const tagged = schnorr.utils.taggedHash;
const base58 = createBase58check(sha256);
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const varBytes = (b: Uint8Array) => concatBytes(Uint8Array.of(b.length), b);
const OP_RETURN = Uint8Array.of(0x6a);

const verify = (address: string, message: string, signature: string, network: BitcoinProofNetwork = "mainnet"): BitcoinMessageVerdict =>
  verifyBitcoinMessage({ address, message, signature, network });
const invalid = (reason: string | RegExp) => ({ state: "invalid", reason: typeof reason === "string" ? reason : expect.stringMatching(reason) });
const inconclusive = (reason: string | RegExp) => ({ state: "inconclusive", reason: typeof reason === "string" ? reason : expect.stringMatching(reason) });
const NO_MATCH = "The signature does not match this address and message";

const simple = (stack: Uint8Array[]) => `smp${toBase64(encodeWitness(stack))}`;
const full = (tx: Tx) => `ful${toBase64(encodeTx(tx))}`;
/** `to_sign` for `address` and `message`, with the fields a test changes. */
function toSign(address: string, message: string, change: Partial<Tx> & { input?: Partial<Tx["inputs"][0]> } = {}): Tx {
  const tx = bip322ToSign(bip322ToSpend(message, decodeBitcoinAddress(address, "mainnet").scriptPubKey));
  const { input, ...rest } = change;
  return { ...tx, ...rest, inputs: [{ ...tx.inputs[0], ...input }] };
}

// ---- The official P2WPKH "Hello World" vector, taken apart ----
const HELLO = basic.simple.find(v => v.message === "Hello World" && v.type === "p2wpkh")!;
const [HELLO_SIG, HELLO_KEY] = decodeWitness(b64(HELLO.bip322_signatures[0].slice(3)));
const helloWith = (sig: Uint8Array, key = HELLO_KEY) => verify(HELLO.address, HELLO.message, simple([sig, key]));

/** DER `30 len 02 lenR R 02 lenS S` + sighash byte, from r and s as minimal big-endian. */
function der(r: Uint8Array, s: Uint8Array, hashType = 1) {
  const int = (x: Uint8Array) => concatBytes(Uint8Array.of(0x02, x.length), x);
  const body = concatBytes(int(r), int(s));
  return concatBytes(Uint8Array.of(0x30, body.length), body, Uint8Array.of(hashType));
}
function splitDer(sig: Uint8Array) {
  const lenR = sig[3], r = sig.subarray(4, 4 + lenR), lenS = sig[5 + lenR], s = sig.subarray(6 + lenR, 6 + lenR + lenS);
  return { r, s };
}
const minimal = (n: bigint) => { const hex = n.toString(16).padStart(2, "0"); const b = Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")); return b[0] & 0x80 ? concatBytes(Uint8Array.of(0), b) : b; };

describe("ECDSA signatures (P2WPKH, from the official vector)", () => {
  it("the untouched vector is valid", () => {
    expect(helloWith(HELLO_SIG)).toEqual({ state: "valid", format: "bip322-simple", script: "p2wpkh" });
    expect(der(splitDer(HELLO_SIG).r, splitDer(HELLO_SIG).s)).toEqual(HELLO_SIG);
  });

  it("refuses the same signature with the high-S twin (malleability)", () => {
    const { r, s } = splitDer(HELLO_SIG);
    const high = der(r, minimal(N - bytesToNumberBE(s)));
    expect(helloWith(high)).toEqual(invalid(NO_MATCH));
  });

  it("refuses any sighash type but SIGHASH_ALL", () => {
    for (const type of [0x00, 0x02, 0x03, 0x81, 0x83]) expect(helloWith(Uint8Array.of(...HELLO_SIG.subarray(0, -1), type))).toEqual(invalid("BIP-322 signatures must use SIGHASH_ALL"));
  });

  it("refuses every departure from strict DER (BIP 66)", () => {
    const { r, s } = splitDer(HELLO_SIG);
    const set = (i: number, v: number) => Uint8Array.from(HELLO_SIG, (b, j) => (j === i ? v : b));
    const lenR = HELLO_SIG[3];
    const cases: [string, Uint8Array][] = [
      ["too short", Uint8Array.of(0x30, 6, 2, 1, 1, 2, 1, 1)],
      ["too long", concatBytes(HELLO_SIG.subarray(0, -1), new Uint8Array(40), Uint8Array.of(1))],
      ["not a sequence", set(0, 0x31)],
      ["wrong total length", set(1, HELLO_SIG[1] + 1)],
      ["R not an integer", set(2, 0x03)],
      ["R of length zero", der(new Uint8Array(0), s)],
      ["R runs past the end", set(3, HELLO_SIG.length)],
      ["S not an integer", set(4 + lenR, 0x03)],
      ["S of length zero", der(r, new Uint8Array(0))],
      ["negative R", der(Uint8Array.of(0x80, ...r.subarray(r[0] === 0 ? 2 : 1)), s)],
      ["R with a needless zero", der(Uint8Array.of(0x00, 0x01, ...r.subarray(1)), s)],
      ["negative S", der(r, Uint8Array.of(0x80, ...s.subarray(1)))],
      ["S with a needless zero", der(r, Uint8Array.of(0x00, 0x01, ...s.subarray(1)))],
    ];
    for (const [name, sig] of cases) expect(helloWith(sig), name).toEqual(invalid(/strictly DER|does not match/));
    // The structural ones never reach the curve: they say DER, not "does not match".
    for (const name of ["not a sequence", "wrong total length", "R of length zero", "negative S", "S with a needless zero"])
      expect(helloWith(cases.find(c => c[0] === name)![1]), name).toEqual(invalid("The signature is not strictly DER-encoded"));
  });

  it("refuses an empty signature, a missing or extra witness item, and a key that is not the address's", () => {
    expect(helloWith(new Uint8Array(0))).toEqual(invalid("The signature is empty"));
    expect(verify(HELLO.address, HELLO.message, simple([HELLO_SIG]))).toEqual(invalid(NO_MATCH));
    expect(verify(HELLO.address, HELLO.message, simple([HELLO_SIG, HELLO_KEY, HELLO_KEY]))).toEqual(invalid(NO_MATCH));
    const uncompressed = secp256k1.Point.fromBytes(HELLO_KEY).toBytes(false);
    expect(helloWith(HELLO_SIG, uncompressed)).toEqual(invalid(NO_MATCH));
    expect(helloWith(HELLO_SIG, secp256k1.getPublicKey(secp256k1.utils.randomSecretKey()))).toEqual(invalid(NO_MATCH));
  });

  it("refuses a native SegWit input that carries a scriptSig", () => {
    const tx = toSign(HELLO.address, HELLO.message, { input: { witness: [HELLO_SIG, HELLO_KEY], scriptSig: Uint8Array.of(0x51) } });
    expect(verify(HELLO.address, HELLO.message, full(tx))).toEqual(invalid("A native SegWit input carries no scriptSig"));
  });
});

describe("the full format's transaction shape", () => {
  const withWitness = (change: Partial<Tx> & { input?: Partial<Tx["inputs"][0]> } = {}) =>
    toSign(HELLO.address, HELLO.message, { ...change, input: { witness: [HELLO_SIG, HELLO_KEY], ...change.input } });

  it("the simple witness wrapped as version 0 verifies", () => {
    expect(verify(HELLO.address, HELLO.message, full(withWitness()))).toMatchObject({ state: "valid", format: "bip322-full" });
  });

  it("refuses to_sign spending another output or with other outputs", () => {
    expect(verify(HELLO.address, HELLO.message, full(withWitness({ input: { vout: 1 } })))).toEqual(invalid(NO_MATCH));
    expect(verify(HELLO.address, HELLO.message, full(withWitness({ input: { txid: new Uint8Array(32) } })))).toEqual(invalid(NO_MATCH));
    for (const outputs of [[], [{ value: 0n, script: OP_RETURN }, { value: 0n, script: OP_RETURN }], [{ value: 1n, script: OP_RETURN }], [{ value: 0n, script: Uint8Array.of(0x6a, 0x00) }]])
      expect(verify(HELLO.address, HELLO.message, full(withWitness({ outputs })))).toEqual(invalid("The signature is not a BIP-322 transaction"));
  });

  it("calls extra inputs a proof of funds and unknown versions inconclusive, never valid", () => {
    const tx = withWitness();
    expect(verify(HELLO.address, HELLO.message, full({ ...tx, inputs: [tx.inputs[0], { ...tx.inputs[0], vout: 5 }] }))).toEqual(inconclusive(/proof of funds/));
    for (const version of [1, 3, -1]) expect(verify(HELLO.address, HELLO.message, full({ ...tx, version }))).toEqual(inconclusive("Unknown BIP-322 transaction version"));
  });

  it("refuses bytes that are not a transaction, or a witness, in the format they claim", () => {
    expect(verify(HELLO.address, HELLO.message, `ful${HELLO.bip322_signatures[0].slice(3)}`)).toEqual(invalid("The signature is not a BIP-322 full transaction"));
    expect(verify(HELLO.address, HELLO.message, `smp${toBase64(Uint8Array.of(...encodeWitness([HELLO_SIG, HELLO_KEY]), 0))}`)).toEqual(invalid("The signature is not a BIP-322 witness"));
    expect(verify(HELLO.address, HELLO.message, "ful")).toEqual(invalid("The signature is empty"));
    expect(verify(HELLO.address, HELLO.message, " smp \n")).toEqual(invalid("The signature is empty"));
  });

  it("reports the signer's time lock rather than refusing it", () => {
    const tx = withWitness({ lockTime: 500 });
    // The witness signs lockTime 0, so a changed lock time must break the signature, not merely be reported.
    expect(verify(HELLO.address, HELLO.message, full(tx))).toEqual(invalid(NO_MATCH));
    const v = generated.full.find(x => x.type === "p2wpkh")!;
    expect(verify(v.address, v.message, v.bip322_signatures[0])).toEqual({ state: "valid", format: "bip322-full", script: "p2wpkh", lockTime: 2016, sequence: 2016 });
  });
});

describe("which addresses each format may prove", () => {
  it("refuses the simple format for legacy and P2SH addresses", () => {
    for (const v of generated.full.filter(x => x.type === "p2pkh" || x.type === "p2sh-p2wpkh")) {
      const witness = toBase64(encodeWitness([HELLO_SIG, HELLO_KEY]));
      expect(verify(v.address, v.message, `smp${witness}`)).toEqual(invalid(/only for native SegWit/));
    }
  });

  it("calls future witness versions inconclusive", () => {
    const v2 = bech32m.encode("bc", [2, ...bech32.toWords(new Uint8Array(16).fill(1))]);
    expect(verify(v2, "m", simple([HELLO_SIG]))).toEqual(inconclusive("This address type cannot be checked here"));
    const v1short = bech32m.encode("bc", [1, ...bech32.toWords(new Uint8Array(20).fill(1))]);
    expect(verify(v1short, "m", simple([HELLO_SIG]))).toEqual(inconclusive("This address type cannot be checked here"));
  });

  it("refuses a P2SH-P2WPKH proof presented for another P2SH address", () => {
    const v = generated.full.find(x => x.type === "p2sh-p2wpkh")!;
    const other = base58.encode(Uint8Array.of(0x05, ...new Uint8Array(20).fill(9)));
    expect(verify(v.address, v.message, v.bip322_signatures[0])).toMatchObject({ state: "valid", script: "p2sh-p2wpkh" });
    expect(verify(other, v.message, v.bip322_signatures[0])).toEqual(invalid(NO_MATCH));
    // The same scriptSig and witness in a to_sign built for the other address: the redeem script is not its.
    const signed = decodeTx(b64(v.bip322_signatures[0].slice(3)));
    const { scriptSig, witness, sequence } = signed.inputs[0];
    const moved = toSign(other, v.message, { version: signed.version, lockTime: signed.lockTime, input: { scriptSig, witness, sequence } });
    expect(verify(other, v.message, full(moved))).toEqual(invalid(NO_MATCH));
  });
});

// ---- P2PKH, full format: the official vector, and fresh keys ----
const P2PKH = generated.full.find(v => v.type === "p2pkh")!;
const P2PKH_TX = decodeTx(b64(P2PKH.bip322_signatures[0].slice(3)));
const pushes = (...items: Uint8Array[]) => concatBytes(...items.map(varBytes));

/** Signs to_sign for a P2PKH address with the original (pre-SegWit) sighash, SIGHASH_ALL. */
function signLegacy(secret: Uint8Array, pubkey: Uint8Array, message: string) {
  const address = base58.encode(Uint8Array.of(0x00, ...hash160(pubkey)));
  const scriptPubKey = decodeBitcoinAddress(address, "mainnet").scriptPubKey;
  const tx = toSign(address, message);
  const digest = sha256d(encodeTx({ ...tx, inputs: [{ ...tx.inputs[0], scriptSig: scriptPubKey }] }, false), u32(1));
  const sig = secp256k1.sign(digest, secret, { prehash: false, lowS: true, format: "der" });
  return { address, tx, sig: concatBytes(sig, Uint8Array.of(1)) };
}

describe("P2PKH proofs", () => {
  it("accepts an uncompressed key, which only legacy addresses may use", () => {
    const secret = secp256k1.utils.randomSecretKey();
    const pubkey = secp256k1.getPublicKey(secret, false);
    const { address, tx, sig } = signLegacy(secret, pubkey, "uncompressed");
    expect(verify(address, "uncompressed", full({ ...tx, inputs: [{ ...tx.inputs[0], scriptSig: pushes(sig, pubkey) }] })))
      .toEqual({ state: "valid", format: "bip322-full", script: "p2pkh" });
    expect(verify(address, "another message", full({ ...tx, inputs: [{ ...tx.inputs[0], scriptSig: pushes(sig, pubkey) }] }))).toEqual(invalid(NO_MATCH));
  });

  it("refuses a hybrid or mislabelled public key, even when it hashes to the address", () => {
    const point = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    for (const key of [Uint8Array.of(0x06 | (point[64] & 1), ...point.subarray(1)), Uint8Array.of(0x04, ...point.subarray(1, 33)), point.subarray(0, 64)]) {
      const address = base58.encode(Uint8Array.of(0x00, ...hash160(key)));
      const tx = toSign(address, "m", { input: { scriptSig: pushes(Uint8Array.of(0x30, 1), key) } });
      expect(verify(address, "m", full(tx))).toEqual(invalid("The signature carries a malformed public key"));
    }
  });

  it("refuses a scriptSig that is not exactly two direct pushes", () => {
    const [sig, key] = [P2PKH_TX.inputs[0].scriptSig.subarray(1, 1 + P2PKH_TX.inputs[0].scriptSig[0]), P2PKH_TX.inputs[0].scriptSig.subarray(2 + P2PKH_TX.inputs[0].scriptSig[0])];
    expect(verify(P2PKH.address, P2PKH.message, full({ ...P2PKH_TX, inputs: [{ ...P2PKH_TX.inputs[0], scriptSig: pushes(sig, key) }] }))).toMatchObject({ state: "valid" });
    const scripts = [
      pushes(sig), pushes(sig, key, key), concatBytes(Uint8Array.of(0x00), pushes(sig, key)), // OP_0 is not a push of data
      concatBytes(Uint8Array.of(0x4c, sig.length), sig, pushes(key)), // PUSHDATA1
      pushes(sig, key).subarray(0, -1), // truncated
      new Uint8Array(0),
    ];
    for (const scriptSig of scripts) expect(verify(P2PKH.address, P2PKH.message, full({ ...P2PKH_TX, inputs: [{ ...P2PKH_TX.inputs[0], scriptSig }] }))).toEqual(invalid(NO_MATCH));
  });

  it("refuses a witness on a P2PKH input and a key of another address", () => {
    expect(verify(P2PKH.address, P2PKH.message, full({ ...P2PKH_TX, inputs: [{ ...P2PKH_TX.inputs[0], witness: [Uint8Array.of(1)] }] }))).toEqual(invalid("A P2PKH input carries no witness"));
    const stranger = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey());
    const sig = P2PKH_TX.inputs[0].scriptSig.subarray(1, 1 + P2PKH_TX.inputs[0].scriptSig[0]);
    expect(verify(P2PKH.address, P2PKH.message, full({ ...P2PKH_TX, inputs: [{ ...P2PKH_TX.inputs[0], scriptSig: pushes(sig, stranger) }] }))).toEqual(invalid(NO_MATCH));
  });
});

// ---- Taproot: fresh keys, the BIP 341 key-path sighash, and script-path commitments ----

const even = (p: InstanceType<typeof secp256k1.Point>) => (p.toAffine().y & 1n) === 0n;
const x32 = (p: InstanceType<typeof secp256k1.Point>) => numberToBytesBE(p.toAffine().x, 32);
/** A P2TR output key committing to `merkleRoot` (or to no script), and the secret that signs its key path. */
function taprootKey(merkleRoot?: Uint8Array) {
  let d = bytesToNumberBE(secp256k1.utils.randomSecretKey());
  let P = G.multiply(d);
  if (!even(P)) { d = N - d; P = P.negate(); }
  const t = bytesToNumberBE(tagged("TapTweak", merkleRoot ? concatBytes(x32(P), merkleRoot) : x32(P)));
  const Q = P.add(G.multiply(t));
  const address = bech32m.encode("bc", [1, ...bech32.toWords(x32(Q))]);
  return { internal: x32(P), output: Q, address, secret: numberToBytesBE((d + t) % N, 32) };
}
/** BIP 341 SigMsg for input 0, key path, no annex, hash types DEFAULT and ALL. */
function taprootSighash(tx: Tx, scriptPubKey: Uint8Array, hashType: number) {
  const i = tx.inputs[0];
  return tagged("TapSighash", concatBytes(Uint8Array.of(0, hashType), u32(tx.version), u32(tx.lockTime),
    sha256(concatBytes(i.txid, u32(i.vout))), sha256(u64(0n)), sha256(varBytes(scriptPubKey)), sha256(u32(i.sequence)),
    sha256(concatBytes(...tx.outputs.map(o => concatBytes(u64(o.value), varBytes(o.script))))), Uint8Array.of(0), u32(0)));
}
function taprootSign(key: ReturnType<typeof taprootKey>, message: string, hashType: number, change: Partial<Tx> = {}) {
  const spk = decodeBitcoinAddress(key.address, "mainnet").scriptPubKey;
  const tx = toSign(key.address, message, change);
  const sig = schnorr.sign(taprootSighash(tx, spk, hashType), key.secret);
  return { tx, sig: hashType === 0 ? sig : concatBytes(sig, Uint8Array.of(hashType)) };
}

describe("Taproot key-path signatures", () => {
  const key = taprootKey();

  it("accepts SIGHASH_DEFAULT and explicit SIGHASH_ALL, simple and full", () => {
    const def = taprootSign(key, "hello", 0), all = taprootSign(key, "hello", 1);
    expect(verify(key.address, "hello", simple([def.sig]))).toEqual({ state: "valid", format: "bip322-simple", script: "p2tr" });
    expect(verify(key.address, "hello", simple([all.sig]))).toEqual({ state: "valid", format: "bip322-simple", script: "p2tr" });
    expect(verify(key.address, "hello", full({ ...all.tx, inputs: [{ ...all.tx.inputs[0], witness: [all.sig] }] }))).toMatchObject({ state: "valid", format: "bip322-full" });
  });

  it("binds the hash type: a DEFAULT signature relabelled ALL, or the reverse, fails", () => {
    const def = taprootSign(key, "hello", 0), all = taprootSign(key, "hello", 1);
    expect(verify(key.address, "hello", simple([concatBytes(def.sig, Uint8Array.of(1))]))).toEqual(invalid(NO_MATCH));
    expect(verify(key.address, "hello", simple([all.sig.subarray(0, 64)]))).toEqual(invalid(NO_MATCH));
  });

  it("refuses other hash types, other lengths, and an empty witness", () => {
    const def = taprootSign(key, "hello", 0);
    for (const type of [0x00, 0x02, 0x03, 0x81]) expect(verify(key.address, "hello", simple([concatBytes(def.sig, Uint8Array.of(type))]))).toEqual(invalid("BIP-322 signatures must use SIGHASH_ALL or SIGHASH_DEFAULT"));
    for (const sig of [def.sig.subarray(0, 63), concatBytes(def.sig, Uint8Array.of(1, 1)), new Uint8Array(0)]) expect(verify(key.address, "hello", simple([sig]))).toEqual(invalid(NO_MATCH));
    expect(verify(key.address, "hello", simple([]))).toEqual(invalid(NO_MATCH));
  });

  it("covers the full format's time lock and version in the signature", () => {
    const locked = taprootSign(key, "hello", 0, { lockTime: 800_000, version: 2 });
    const tx = { ...locked.tx, inputs: [{ ...locked.tx.inputs[0], witness: [locked.sig] }] };
    expect(verify(key.address, "hello", full(tx))).toEqual({ state: "valid", format: "bip322-full", script: "p2tr", lockTime: 800_000, sequence: 0 });
    expect(verify(key.address, "hello", full({ ...tx, lockTime: 800_001 }))).toEqual(invalid(NO_MATCH));
    expect(verify(key.address, "hello", full({ ...tx, version: 0 }))).toEqual(invalid(NO_MATCH));
  });

  it("refuses a Taproot input carrying a scriptSig, and another key's signature", () => {
    const def = taprootSign(key, "hello", 0);
    expect(verify(key.address, "hello", full({ ...def.tx, inputs: [{ ...def.tx.inputs[0], witness: [def.sig], scriptSig: Uint8Array.of(0x51) }] })))
      .toEqual(invalid("A native SegWit input carries no scriptSig"));
    expect(verify(taprootKey().address, "hello", simple([def.sig]))).toEqual(invalid(NO_MATCH));
  });
});

describe("Taproot script-path witnesses", () => {
  const leafScript = Uint8Array.of(0x51); // OP_TRUE: what it does is irrelevant, only the commitment is checked
  const leaf = tagged("TapLeaf", Uint8Array.of(0xc0), varBytes(leafScript));
  const branch = (a: Uint8Array, b: Uint8Array) => tagged("TapBranch", ...(Buffer.compare(a, b) < 0 ? [a, b] : [b, a]));
  // Two siblings, one sorting below every hash and one above, so both orders of a branch are taken.
  const low = new Uint8Array(32), high = new Uint8Array(32).fill(0xff);
  const root = branch(branch(leaf, low), high);
  const key = taprootKey(root);
  const control = (internal = key.internal, path = [low, high], parity = Number(key.output.toAffine().y & 1n)) => concatBytes(Uint8Array.of(0xc0 | parity), internal, ...path);

  it("calls a witness that commits to the output key inconclusive, never valid", () => {
    expect(verify(key.address, "m", simple([new Uint8Array(64), leafScript, control()]))).toEqual(inconclusive(/script-path/));
  });

  it("refuses a script-path witness that does not commit to the output key", () => {
    const parity = Number(key.output.toAffine().y & 1n);
    const bad = [
      control(key.internal, [high, low]), // siblings in another order: another root
      control(key.internal, [low]), // a shorter path
      control(taprootKey().internal), // another internal key
      control(key.internal, [low, high], parity ^ 1), // the wrong parity bit
      control(new Uint8Array(32).fill(0xff)), // not an x coordinate on the curve
      control().subarray(0, 32), // shorter than a control block
      concatBytes(control(), Uint8Array.of(0)), // not 33 + 32k bytes
      concatBytes(Uint8Array.of(0xc0), key.internal, new Uint8Array(32 * 129)), // deeper than 128
    ];
    for (const c of bad) expect(verify(key.address, "m", simple([new Uint8Array(64), leafScript, c]))).toEqual(invalid(NO_MATCH));
  });

  it("calls an annex inconclusive", () => {
    const def = taprootSign(taprootKey(), "m", 0);
    const k = taprootKey();
    expect(verify(k.address, "m", simple([def.sig, Uint8Array.of(0x50, 1, 2)]))).toEqual(inconclusive(/annex/));
  });
});

describe("legacy signmessage and input limits", () => {
  const legacyAddress = "15CRxFdyRpGZLW9w8HnHvVduizdL5jKNbs";
  const legacySig = "IPojfrX2dfPnH26UegfbGQQLrdK844DlHq5157/P6h57WyuS/Qsl+h/WSVGDF4MUi4rWSswW38oimDYfNNUBUOk=";

  it("refuses a recoverable signature whose r and s cannot recover a key", () => {
    for (const header of [27, 31]) expect(verify(legacyAddress, "Trust no one", toBase64(Uint8Array.of(header, ...new Uint8Array(64))))).toEqual(invalid(NO_MATCH));
    const overflow = Uint8Array.of(31, ...new Uint8Array(32).fill(0xff), ...new Uint8Array(32).fill(1));
    expect(verify(legacyAddress, "Trust no one", toBase64(overflow))).toEqual(invalid(NO_MATCH));
  });

  it("refuses a legacy signature for a P2SH address", () => {
    const p2sh = generated.full.find(x => x.type === "p2sh-p2wpkh")!.address;
    expect(verify(p2sh, "Trust no one", legacySig)).toEqual(invalid(/only for legacy/));
  });

  it("counts the message limit in bytes, and the signature limit in characters", () => {
    expect(verify(legacyAddress, "\u00e9".repeat(8193), legacySig)).toEqual(invalid("The message is too long"));
    expect(verify(legacyAddress, "a".repeat(16 * 1024), legacySig)).toEqual(invalid(NO_MATCH));
    expect(verify(legacyAddress, "m", "A".repeat(16 * 1024 + 1))).toEqual(invalid("The signature is too long"));
    expect(verify(legacyAddress, "m", `smp${"A".repeat(16 * 1024 - 3)}`).state).toBe("invalid");
  });

  it("says what is missing instead of throwing on non-string input or an unknown network", () => {
    for (const input of [{ address: 1, message: "m", signature: legacySig }, { address: legacyAddress, message: null, signature: legacySig }, { address: legacyAddress, message: "m", signature: undefined }])
      expect(verifyBitcoinMessage({ ...input, network: "mainnet" } as never)).toEqual(invalid("Missing address, message or signature"));
    expect(verifyBitcoinMessage({ address: legacyAddress, message: "m", signature: legacySig, network: "regtest" as BitcoinProofNetwork })).toEqual(invalid("The signature could not be read"));
  });

  it("never throws and never calls garbage valid", () => {
    const addresses = [HELLO.address, P2PKH.address, legacyAddress, taprootKey().address, generated.full.find(x => x.type === "p2sh-p2wpkh")!.address];
    const signature = fc.oneof(
      fc.string({ maxLength: 300 }),
      fc.uint8Array({ maxLength: 250 }).map(b => toBase64(b)),
      fc.tuple(fc.constantFrom("smp", "ful", "pof", ""), fc.uint8Array({ maxLength: 250 })).map(([p, b]) => p + toBase64(b)),
    );
    fc.assert(fc.property(fc.constantFrom(...addresses), fc.string({ maxLength: 40 }), signature, (address, message, sig) => {
      const verdict = verify(address, message, sig);
      expect(verdict.state).not.toBe("valid");
      expect(typeof (verdict as { reason: string }).reason).toBe("string");
    }), { numRuns: 300 });
  });
});
