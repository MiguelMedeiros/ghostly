import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, bech32m, createBase58check } from "@scure/base";
import { concatBytes } from "./bytes";

/**
 * The little of Bitcoin's address and transaction formats a message-signature verifier needs: decoding an
 * address to its output script, and (de)serialising the two virtual transactions of BIP-322. Nothing here
 * builds, signs or broadcasts a real transaction.
 */

/** Which addresses a proof may name: the real network, or any of the test networks (testnet, signet, regtest…). */
export type BitcoinProofNetwork = "mainnet" | "testnet";
export type BitcoinScriptType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "witness-unknown";

export interface BitcoinAddressInfo {
  address: string;
  type: BitcoinScriptType;
  network: BitcoinProofNetwork;
  /** The output script paying this address. */
  scriptPubKey: Uint8Array;
  /** The key/script hash of a base58 address, or the witness program of a SegWit one. */
  program: Uint8Array;
  witnessVersion?: number;
}

const base58check = createBase58check(sha256);
export const sha256d = (...parts: Uint8Array[]) => sha256(sha256(concatBytes(...parts)));
export const hash160 = (data: Uint8Array) => ripemd160(sha256(data));

/** Base58 versions: P2PKH, P2SH. Every test network (testnet3/4, signet, mutinynet, regtest) shares one pair. */
const BASE58 = { mainnet: [0x00, 0x05], testnet: [0x6f, 0xc4] } as const;
const HRP = { mainnet: ["bc"], testnet: ["tb", "bcrt"] } as const;

function decodeSegwit(address: string): { hrp: string; version: number; program: Uint8Array } | undefined {
  // BIP 173: one case only; the checksum is over the lower-case form.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return undefined;
  const lower = address.toLowerCase() as `${string}1${string}`;
  for (const [coder, v0] of [[bech32, true], [bech32m, false]] as const) {
    let decoded: { prefix: string; words: number[] };
    try { decoded = coder.decode(lower, 90); } catch { continue; }
    if (decoded.words.length < 1) return undefined;
    const version = decoded.words[0];
    // Version 0 is bech32 (BIP 173), every later version bech32m (BIP 350); the wrong one is refused.
    if (version > 16 || (version === 0) !== v0) return undefined;
    let program: Uint8Array;
    try { program = coder.fromWords(decoded.words.slice(1)); } catch { return undefined; }
    if (program.length < 2 || program.length > 40 || (version === 0 && program.length !== 20 && program.length !== 32)) return undefined;
    return { hrp: decoded.prefix, version, program };
  }
  return undefined;
}

/** An address refused, with a reason fit to show the person. */
export class BitcoinAddressError extends Error {}

/** Decodes `address` for `network`, or throws a `BitcoinAddressError` saying what is wrong with it. */
export function decodeBitcoinAddress(address: string, network: BitcoinProofNetwork): BitcoinAddressInfo {
  if (typeof address !== "string" || address.length < 14 || address.length > 90) throw new BitcoinAddressError("Not a Bitcoin address");
  const other: BitcoinProofNetwork = network === "mainnet" ? "testnet" : "mainnet";
  const wrongNetwork = () => new BitcoinAddressError(network === "mainnet"
    ? "This is a test-network address; switch the wallets to Testnet to use it"
    : "This is a mainnet address; switch the wallets to Mainnet to use it");
  const segwit = decodeSegwit(address);
  if (segwit) {
    if (!(HRP[network] as readonly string[]).includes(segwit.hrp)) {
      if ((HRP[other] as readonly string[]).includes(segwit.hrp)) throw wrongNetwork();
      throw new BitcoinAddressError("Not a Bitcoin address");
    }
    const { version, program } = segwit;
    const type: BitcoinScriptType = version === 0 ? (program.length === 20 ? "p2wpkh" : "p2wsh") : version === 1 && program.length === 32 ? "p2tr" : "witness-unknown";
    const scriptPubKey = concatBytes(Uint8Array.of(version === 0 ? 0x00 : 0x50 + version, program.length), program);
    return { address, type, network, scriptPubKey, program, witnessVersion: version };
  }
  let payload: Uint8Array;
  try { payload = base58check.decode(address); } catch { throw new BitcoinAddressError("Not a Bitcoin address (bad checksum?)"); }
  if (payload.length !== 21) throw new BitcoinAddressError("Not a Bitcoin address");
  const [pkh, sh] = BASE58[network];
  const hash = payload.slice(1);
  if (payload[0] === pkh) return { address, type: "p2pkh", network, program: hash, scriptPubKey: concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac)) };
  if (payload[0] === sh) return { address, type: "p2sh", network, program: hash, scriptPubKey: concatBytes(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87)) };
  if ((BASE58[other] as readonly number[]).includes(payload[0])) throw wrongNetwork();
  throw new BitcoinAddressError("Not a Bitcoin address");
}

// ---- Transactions (consensus serialisation) ----

export interface TxInput { txid: Uint8Array; vout: number; scriptSig: Uint8Array; sequence: number; witness: Uint8Array[] }
export interface TxOutput { value: bigint; script: Uint8Array }
export interface Tx { version: number; inputs: TxInput[]; outputs: TxOutput[]; lockTime: number }

export function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b; }
  throw new Error("Too large");
}
export const varBytes = (b: Uint8Array) => concatBytes(compactSize(b.length), b);
export const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
export const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

export function encodeTx(tx: Tx, withWitness = tx.inputs.some(i => i.witness.length > 0)): Uint8Array {
  const parts: Uint8Array[] = [u32(tx.version)];
  if (withWitness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(i.txid, u32(i.vout), varBytes(i.scriptSig), u32(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), varBytes(o.script));
  if (withWitness) for (const i of tx.inputs) parts.push(encodeWitness(i.witness));
  parts.push(u32(tx.lockTime));
  return concatBytes(...parts);
}
export const encodeWitness = (stack: Uint8Array[]) => concatBytes(compactSize(stack.length), ...stack.map(varBytes));
/** The id other transactions refer to it by, in internal byte order (reverse it for display). */
export const txHash = (tx: Tx) => sha256d(encodeTx(tx, false));

/** A strict reader: canonical sizes only, and the whole input must be consumed. */
export class ByteReader {
  private at = 0;
  constructor(private bytes: Uint8Array) {}
  get done() { return this.at === this.bytes.length; }
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.at + n > this.bytes.length) throw new Error("Truncated data");
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  peek(): number { if (this.done) throw new Error("Truncated data"); return this.bytes[this.at]; }
  u32(): number { return new DataView(this.take(4).buffer).getUint32(0, true); }
  i32(): number { return new DataView(this.take(4).buffer).getInt32(0, true); }
  u64(): bigint { return new DataView(this.take(8).buffer).getBigUint64(0, true); }
  compactSize(): number {
    const first = this.take(1)[0];
    const [n, min] = first < 0xfd ? [first, 0] : first === 0xfd ? [new DataView(this.take(2).buffer).getUint16(0, true), 0xfd]
      : first === 0xfe ? [this.u32(), 0x10000] : [Number(this.u64()), 0x100000000];
    if (n < min || n > 0x02000000) throw new Error("Non-canonical size");
    return n;
  }
  varBytes(): Uint8Array { return this.take(this.compactSize()); }
  end() { if (!this.done) throw new Error("Unexpected trailing data"); }
}

export function decodeWitness(bytes: Uint8Array): Uint8Array[] {
  const r = new ByteReader(bytes);
  const stack = readWitness(r);
  r.end();
  return stack;
}
function readWitness(r: ByteReader): Uint8Array[] {
  const n = r.compactSize();
  return Array.from({ length: n }, () => r.varBytes());
}

export function decodeTx(bytes: Uint8Array): Tx {
  const r = new ByteReader(bytes);
  const version = r.i32();
  let segwit = false;
  if (r.peek() === 0x00) {
    r.take(1);
    if (r.take(1)[0] !== 0x01) throw new Error("Unknown transaction flag");
    segwit = true;
  }
  const inputs: TxInput[] = Array.from({ length: r.compactSize() }, () => ({ txid: r.take(32), vout: r.u32(), scriptSig: r.varBytes(), sequence: r.u32(), witness: [] }));
  const outputs: TxOutput[] = Array.from({ length: r.compactSize() }, () => ({ value: r.u64(), script: r.varBytes() }));
  if (segwit) {
    for (const input of inputs) input.witness = readWitness(r);
    // A witness flag with nothing in it is a non-canonical serialisation (Bitcoin Core refuses it).
    if (inputs.every(i => i.witness.length === 0)) throw new Error("Superfluous witness flag");
  }
  const lockTime = r.u32();
  r.end();
  return { version, inputs, outputs, lockTime };
}
