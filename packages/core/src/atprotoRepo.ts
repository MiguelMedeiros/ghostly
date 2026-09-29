import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/**
 * Checking one record of an AT Protocol repository without trusting the server that serves it: the
 * CAR file `com.atproto.sync.getRecord` returns holds the signed commit, the Merkle Search Tree nodes
 * from the commit's root down to the record, and the record itself. Every block is checked against its
 * hash, the commit's signature against the DID's signing key, and the path through the tree to the key
 * `collection/rkey`. Only what atproto's data model uses is accepted (DAG-CBOR without floats or
 * undefined, CIDv1 with SHA-256), strictly: canonical lengths and map order, so re-encoding the unsigned
 * commit gives exactly the bytes that were signed.
 *
 * Specs: https://atproto.com/specs/repository, https://atproto.com/specs/data-model,
 * https://atproto.com/specs/cryptography. No network here: the caller fetches, bounded.
 */

export class AtprotoProofError extends Error {}
const fail = (message: string): never => { throw new AtprotoProofError(message); };

// ---------------------------------------------------------------------------------------------
// CIDs

const CODEC_DAG_CBOR = 0x71, CODEC_RAW = 0x55, HASH_SHA256 = 0x12;

/** A CIDv1 as atproto uses it: dag-cbor or raw, SHA-256. */
export class AtprotoCid {
  constructor(readonly bytes: Uint8Array, readonly codec: number, readonly digest: Uint8Array) {}
  /** Stable key for maps: the CID's bytes in hex. */
  get key(): string { return toHex(this.bytes); }
  equals(other: AtprotoCid): boolean { return this.key === other.key; }
}

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0, shift = 0, i = offset;
  for (;;) {
    if (i >= bytes.length) fail("Truncated varint");
    const b = bytes[i++];
    if (shift === 49 && b > 0x0f) fail("Varint too large");
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) {
      if (b === 0 && i - offset > 1) fail("Varint not minimal");
      return [value, i];
    }
    shift += 7;
    if (shift > 49) fail("Varint too large");
  }
}

/** A binary CID at `offset`; returns it and where it ends. */
export function readAtprotoCid(bytes: Uint8Array, offset = 0): [AtprotoCid, number] {
  const [version, a] = readVarint(bytes, offset);
  if (version !== 1) fail("Only CIDv1 is accepted");
  const [codec, b] = readVarint(bytes, a);
  if (codec !== CODEC_DAG_CBOR && codec !== CODEC_RAW) fail("Unknown CID codec");
  const [hash, c] = readVarint(bytes, b);
  if (hash !== HASH_SHA256) fail("Only SHA-256 CIDs are accepted");
  const [length, d] = readVarint(bytes, c);
  if (length !== 32 || d + 32 > bytes.length) fail("Bad CID digest");
  return [new AtprotoCid(bytes.slice(offset, d + 32), codec, bytes.slice(d, d + 32)), d + 32];
}

/** The CID of `data` under `codec` (dag-cbor by default). */
export function atprotoCidFor(data: Uint8Array, codec = CODEC_DAG_CBOR): AtprotoCid {
  const digest = sha256(data);
  return new AtprotoCid(new Uint8Array([1, codec, HASH_SHA256, 32, ...digest]), codec, digest);
}

// ---------------------------------------------------------------------------------------------
// DAG-CBOR

/** A decoded DAG-CBOR value. Maps are null-prototype objects, links are `AtprotoCid`. */
export type CborValue = null | boolean | number | string | Uint8Array | AtprotoCid | CborValue[] | { [key: string]: CborValue };

const MAX_DEPTH = 32;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

/** DAG-CBOR key order: shorter first, then bytewise. */
function compareKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Decodes exactly one DAG-CBOR value filling all of `bytes`. */
export function decodeDagCbor(bytes: Uint8Array): CborValue {
  let offset = 0;
  const need = (n: number) => { if (offset + n > bytes.length) fail("Truncated CBOR"); };
  const head = (): [major: number, value: number] => {
    need(1);
    const b = bytes[offset++], major = b >> 5, info = b & 31;
    if (info < 24) return [major, info];
    if (info === 24) { need(1); const v = bytes[offset++]; if (v < 24) fail("CBOR length not minimal"); return [major, v]; }
    if (info === 25) { need(2); const v = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; if (v < 0x100) fail("CBOR length not minimal"); return [major, v]; }
    if (info === 26) { need(4); const v = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]; offset += 4; if (v < 0x10000) fail("CBOR length not minimal"); return [major, v]; }
    if (info === 27) {
      need(8);
      const hi = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
      const lo = ((bytes[offset + 4] << 24) >>> 0) + (bytes[offset + 5] << 16) + (bytes[offset + 6] << 8) + bytes[offset + 7];
      offset += 8;
      if (hi === 0) fail("CBOR length not minimal");
      if (hi > 0x1fffff) fail("CBOR integer too large");
      return [major, hi * 2 ** 32 + lo];
    }
    return fail(info === 31 ? "Indefinite-length CBOR is not DAG-CBOR" : "Reserved CBOR value");
  };
  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) fail("CBOR nested too deeply");
    const [major, value] = head();
    switch (major) {
      case 0: return value;
      case 1: return -1 - value;
      case 2: { need(value); const out = bytes.slice(offset, offset + value); offset += value; return out; }
      case 3: {
        need(value);
        let text: string;
        try { text = textDecoder.decode(bytes.subarray(offset, offset + value)); } catch { return fail("CBOR text is not UTF-8"); }
        offset += value;
        return text;
      }
      case 4: {
        if (value > bytes.length - offset) fail("Truncated CBOR");
        const out: CborValue[] = [];
        for (let i = 0; i < value; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        if (value * 2 > bytes.length - offset) fail("Truncated CBOR");
        const out = Object.create(null) as { [key: string]: CborValue };
        let previous: Uint8Array | null = null;
        for (let i = 0; i < value; i++) {
          const [keyMajor, keyLength] = head();
          if (keyMajor !== 3) fail("CBOR map keys must be text");
          need(keyLength);
          const raw = bytes.subarray(offset, offset + keyLength);
          if (previous && compareKeys(previous, raw) >= 0) fail("CBOR map keys out of order or repeated");
          previous = raw;
          let key: string;
          try { key = textDecoder.decode(raw); } catch { return fail("CBOR text is not UTF-8"); }
          offset += keyLength;
          out[key] = item(depth + 1);
        }
        return out;
      }
      case 6: {
        if (value !== 42) fail("Only CID links (tag 42) are allowed");
        const [inner, length] = head();
        if (inner !== 2) fail("A CID link must be bytes");
        need(length);
        if (length < 2 || bytes[offset] !== 0) fail("Bad CID link");
        const [cid, end] = readAtprotoCid(bytes.subarray(offset + 1, offset + length));
        if (end !== length - 1) fail("Bad CID link");
        offset += length;
        return cid;
      }
      default: {
        if (value === 20) return false;
        if (value === 21) return true;
        if (value === 22) return null;
        return fail("Floats and undefined are not in atproto's data model");
      }
    }
  };
  const out = item(0);
  if (offset !== bytes.length) fail("Trailing bytes after CBOR");
  return out;
}

/** Encodes a value as DAG-CBOR (canonical: minimal lengths, sorted keys). */
export function encodeDagCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new AtprotoProofError("Cannot encode this number");
    const m = major << 5;
    if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    else { const hi = Math.floor(n / 2 ** 32), lo = n >>> 0; out.push(m | 27, (hi >>> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >> 16) & 0xff, (lo >> 8) & 0xff, lo & 0xff); }
  };
  const bytesOut = (b: Uint8Array) => { for (const x of b) out.push(x); };
  const item = (v: CborValue) => {
    if (v === null) out.push(0xf6);
    else if (v === true) out.push(0xf5);
    else if (v === false) out.push(0xf4);
    else if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new AtprotoProofError("Only integers are in atproto's data model"); if (v >= 0) head(0, v); else head(1, -1 - v); }
    else if (typeof v === "string") { const b = textEncoder.encode(v); head(3, b.length); bytesOut(b); }
    else if (v instanceof Uint8Array) { head(2, v.length); bytesOut(v); }
    else if (v instanceof AtprotoCid) { head(6, 42); head(2, v.bytes.length + 1); out.push(0); bytesOut(v.bytes); }
    else if (Array.isArray(v)) { head(4, v.length); v.forEach(item); }
    else {
      const entries = Object.keys(v).map(k => [textEncoder.encode(k), v[k]] as const).sort((a, b) => compareKeys(a[0], b[0]));
      head(5, entries.length);
      for (const [k, x] of entries) { head(3, k.length); bytesOut(k); item(x); }
    }
  };
  item(value);
  return new Uint8Array(out);
}

const isMap = (v: CborValue): v is { [key: string]: CborValue } =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof AtprotoCid);

function exactKeys(v: CborValue, required: readonly string[], optional: readonly string[] = []): { [key: string]: CborValue } {
  if (!isMap(v)) fail("Expected a map");
  const obj = v as { [key: string]: CborValue };
  for (const k of required) if (!(k in obj)) fail(`Missing field ${k}`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) fail(`Unexpected field ${k}`);
  return obj;
}

// ---------------------------------------------------------------------------------------------
// CAR v1

export interface AtprotoCar { roots: AtprotoCid[]; blocks: Map<string, { cid: AtprotoCid; data: Uint8Array }> }

/** Parses a CARv1 file and checks every block against its CID. */
export function parseAtprotoCar(bytes: Uint8Array, { maxBlocks = 1024 }: { maxBlocks?: number } = {}): AtprotoCar {
  const [headerLength, start] = readVarint(bytes, 0);
  if (headerLength === 0 || start + headerLength > bytes.length) fail("Bad CAR header");
  const header = exactKeys(decodeDagCbor(bytes.subarray(start, start + headerLength)), ["roots", "version"]);
  if (header.version !== 1) fail("Only CAR v1 is accepted");
  const roots = header.roots;
  if (!Array.isArray(roots) || roots.length < 1 || !roots.every(r => r instanceof AtprotoCid)) fail("Bad CAR roots");
  const blocks: AtprotoCar["blocks"] = new Map();
  let offset = start + headerLength;
  while (offset < bytes.length) {
    const [length, next] = readVarint(bytes, offset);
    if (length === 0 || next + length > bytes.length) fail("Truncated CAR block");
    const section = bytes.subarray(next, next + length);
    const [cid, dataStart] = readAtprotoCid(section);
    const data = section.slice(dataStart);
    const digest = sha256(data);
    if (toHex(digest) !== toHex(cid.digest)) fail("A block does not match its hash");
    blocks.set(cid.key, { cid, data });
    if (blocks.size > maxBlocks) fail("Too many blocks in the CAR");
    offset = next + length;
  }
  return { roots: roots as AtprotoCid[], blocks };
}

// ---------------------------------------------------------------------------------------------
// Keys (did:key multibase, and the DID document's two encodings)

export type AtprotoKeyType = "secp256k1" | "p256";
export interface AtprotoPublicKey { type: AtprotoKeyType; /** Compressed SEC1 point (33 bytes). */ key: Uint8Array }

const MULTICODEC_K256 = [0xe7, 0x01], MULTICODEC_P256 = [0x80, 0x24];

function compress(type: AtprotoKeyType, key: Uint8Array): Uint8Array {
  const curve = type === "secp256k1" ? secp256k1 : p256;
  try { return curve.Point.fromBytes(key).toBytes(true); } catch { return fail("Invalid public key"); }
}

/**
 * The atproto signing key of a DID document's verification method: `Multikey` (multicodec-prefixed,
 * compressed) or the legacy `EcdsaSecp256k1VerificationKey2019` / `EcdsaSecp256r1VerificationKey2019`
 * (the bare point). Both are base58btc multibase ("z…").
 */
export function parseAtprotoVerificationKey(type: string, publicKeyMultibase: string): AtprotoPublicKey {
  if (typeof publicKeyMultibase !== "string" || !publicKeyMultibase.startsWith("z") || publicKeyMultibase.length > 200) fail("Unsupported key encoding");
  let raw: Uint8Array;
  try { raw = base58.decode(publicKeyMultibase.slice(1)); } catch { return fail("Unsupported key encoding"); }
  if (type === "Multikey") {
    if (raw[0] === MULTICODEC_K256[0] && raw[1] === MULTICODEC_K256[1]) return { type: "secp256k1", key: compress("secp256k1", raw.subarray(2)) };
    if (raw[0] === MULTICODEC_P256[0] && raw[1] === MULTICODEC_P256[1]) return { type: "p256", key: compress("p256", raw.subarray(2)) };
    return fail("Unsupported key type");
  }
  const legacy = type === "EcdsaSecp256k1VerificationKey2019" ? "secp256k1" : type === "EcdsaSecp256r1VerificationKey2019" ? "p256" : null;
  if (!legacy) return fail("Unsupported key type");
  return { type: legacy, key: compress(legacy, raw) };
}

/** A `did:key:z…` (atproto's form, multicodec-prefixed compressed key). */
export function parseAtprotoDidKey(didKey: string): AtprotoPublicKey {
  if (!didKey.startsWith("did:key:")) fail("Not a did:key");
  return parseAtprotoVerificationKey("Multikey", didKey.slice("did:key:".length));
}

/** atproto signatures: ECDSA over SHA-256 of the bytes, 64-byte compact r‖s, low-S only. */
export function verifyAtprotoSignature(key: AtprotoPublicKey, data: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const curve = key.type === "secp256k1" ? secp256k1 : p256;
  try { return curve.verify(sig, sha256(data), key.key, { prehash: false, lowS: true, format: "compact" }); } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Commits and the Merkle Search Tree

export interface AtprotoCommit { did: string; version: 3; data: AtprotoCid; rev: string; prev: AtprotoCid | null; sig: Uint8Array }

export function decodeAtprotoCommit(data: Uint8Array): AtprotoCommit {
  const c = exactKeys(decodeDagCbor(data), ["data", "did", "rev", "sig", "version"], ["prev"]);
  if (c.version !== 3) fail("Unsupported commit version");
  if (typeof c.did !== "string" || !(c.data instanceof AtprotoCid) || typeof c.rev !== "string" || !(c.sig instanceof Uint8Array)) fail("Malformed commit");
  const prev = c.prev ?? null;
  if (prev !== null && !(prev instanceof AtprotoCid)) fail("Malformed commit");
  return { did: c.did as string, version: 3, data: c.data as AtprotoCid, rev: c.rev as string, prev: prev as AtprotoCid | null, sig: c.sig as Uint8Array };
}

/** The bytes a commit's signature covers: the commit without `sig`, re-encoded. */
export function unsignedCommitBytes(data: Uint8Array): Uint8Array {
  const c = decodeDagCbor(data) as { [key: string]: CborValue };
  const { sig: _sig, ...unsigned } = c;
  return encodeDagCbor(unsigned);
}

interface MstEntry { key: Uint8Array; value: AtprotoCid; right: AtprotoCid | null }

function decodeMstNode(data: Uint8Array): { left: AtprotoCid | null; entries: MstEntry[] } {
  const node = exactKeys(decodeDagCbor(data), ["e", "l"]);
  if (node.l !== null && !(node.l instanceof AtprotoCid)) fail("Malformed tree node");
  if (!Array.isArray(node.e)) fail("Malformed tree node");
  const entries: MstEntry[] = [];
  let previous = new Uint8Array(0);
  for (const raw of node.e as CborValue[]) {
    const e = exactKeys(raw, ["k", "p", "t", "v"]);
    if (typeof e.p !== "number" || !Number.isSafeInteger(e.p) || e.p < 0 || e.p > previous.length || !(e.k instanceof Uint8Array) ||
        !(e.v instanceof AtprotoCid) || (e.t !== null && !(e.t instanceof AtprotoCid))) fail("Malformed tree entry");
    const key = new Uint8Array((e.p as number) + (e.k as Uint8Array).length);
    key.set(previous.subarray(0, e.p as number));
    key.set(e.k as Uint8Array, e.p as number);
    if (key.length > 1024) fail("Tree key too long");
    if (entries.length && compareBytes(entries[entries.length - 1].key, key) >= 0) fail("Tree keys out of order");
    entries.push({ key, value: e.v as AtprotoCid, right: e.t as AtprotoCid | null });
    previous = key;
  }
  return { left: node.l as AtprotoCid | null, entries };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Walks the tree from `root` to `key`. Returns the value's CID, or null when the blocks prove the key is
 * absent. Throws when a block on the path is missing: the CAR proves neither.
 */
export function findInMst(blocks: AtprotoCar["blocks"], root: AtprotoCid, key: string, { maxDepth = 64 }: { maxDepth?: number } = {}): AtprotoCid | null {
  const target = textEncoder.encode(key);
  let current: AtprotoCid | null = root;
  for (let depth = 0; current; depth++) {
    if (depth > maxDepth) fail("Tree too deep");
    const block = blocks.get(current.key);
    if (!block) return fail("The proof is missing part of the repository tree");
    if (block.cid.codec !== CODEC_DAG_CBOR) fail("Malformed tree node");
    const node = decodeMstNode(block.data);
    let next: AtprotoCid | null = node.left;
    let descended = false;
    for (let i = 0; i < node.entries.length; i++) {
      const order = compareBytes(target, node.entries[i].key);
      if (order === 0) return node.entries[i].value;
      if (order < 0) { next = i === 0 ? node.left : node.entries[i - 1].right; descended = true; break; }
    }
    if (!descended) next = node.entries.length ? node.entries[node.entries.length - 1].right : node.left;
    current = next;
  }
  return null;
}

/** What a verified record proof says. */
export interface AtprotoRecordProof {
  commit: AtprotoCommit;
  /** The record's CID and its decoded value, or null when the repository proves it absent. */
  record: { cid: AtprotoCid; value: { [key: string]: CborValue } } | null;
}

/**
 * Verifies a `com.atproto.sync.getRecord` CAR for `did`'s `collection/rkey`, signed by `key` (from the DID
 * document, never from the CAR or the server). Throws AtprotoProofError on any mismatch.
 */
export function verifyAtprotoRecordProof(car: Uint8Array, options: { did: string; key: AtprotoPublicKey; collection: string; rkey: string }): AtprotoRecordProof {
  const parsed = parseAtprotoCar(car);
  const root = parsed.roots[0];
  const commitBlock = parsed.blocks.get(root.key);
  if (!commitBlock || root.codec !== CODEC_DAG_CBOR) fail("The proof has no commit");
  const commit = decodeAtprotoCommit(commitBlock!.data);
  if (commit.did !== options.did) fail("The commit is for another account");
  if (!verifyAtprotoSignature(options.key, unsignedCommitBytes(commitBlock!.data), commit.sig)) fail("The commit is not signed by the account's key");
  const cid = findInMst(parsed.blocks, commit.data, `${options.collection}/${options.rkey}`);
  if (!cid) return { commit, record: null };
  const block = parsed.blocks.get(cid.key);
  if (!block) return fail("The proof is missing the record");
  if (cid.codec !== CODEC_DAG_CBOR) fail("The record is not DAG-CBOR");
  const value = decodeDagCbor(block.data);
  if (!isMap(value)) fail("The record is not an object");
  return { commit, record: { cid, value: value as { [key: string]: CborValue } } };
}
