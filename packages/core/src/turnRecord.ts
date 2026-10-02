import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual, concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { decodeTxtPacket, encodeTxtPacket } from "./dns";
import { identityFromSeed, verify, type Identity } from "./identity";
import { openRelayPayload, signRelayPayload } from "./pkarr";

/*
 * The turn record (WISP 06 § The turn, § Record): one Pkarr packet under a key only holders of the device-set secret
 * `D` can derive, which says which of a person's devices is the active one. This file is the record alone: its keys,
 * its fixed binary body, its sequence number, and the reader's rules. Nothing here touches the network (`turnRead.ts`
 * classifies what the sources answered, `relay.ts` and the Desktop's Rust read and put) or the device state
 * (`packages/browser/src/devices`).
 *
 * The same bytes are produced and read by the Desktop's Rust (`apps/desktop/src/turn_record.rs`); both test suites
 * read `packages/core/test/vectors/turn-record.json`.
 */

/** The record's format, byte 0 of the body. */
export const TURN_VERSION = 1;
/** The device set holds four devices at most; each has a slot of the record. */
export const TURN_SLOTS = 4;
export const TURN_NAME_BYTES = 16;
/** The body's length, and how much of it the author signs (everything before its signature). */
export const TURN_BODY_BYTES = 374;
export const TURN_SIGNED_BYTES = 310;
/** `nonce(24) || box`, the box 16 bytes longer than the body. */
export const TURN_SEALED_BYTES = 24 + TURN_BODY_BYTES + 16;
/** The highest turn of an ordinary record. One above it is the tombstone's. */
export const TURN_MAX = 2 ** 32 - 2;
export const TOMBSTONE_TURN = 2 ** 32 - 1;
/** `rev` stays under this; when it would reach it the active device writes the next turn, released to itself. */
export const TURN_REV_LIMIT = 2 ** 18;
/** Every tombstone has this one sequence number, the highest there is: no ordinary record outranks it. */
export const TOMBSTONE_SEQUENCE = 2 ** 52 - 1;
/** `active` in a tombstone, and nowhere else. */
export const TURN_NO_ACTIVE = 255;
/** The record's one TXT label: a label that says nothing. */
export const TURN_LABEL = "_s";
/** The TTL of the TXT record. Part of the signed bytes, so fixed. */
export const TURN_TTL = 300;

const SALT = utf8Encode("ghostly-devices/1");
const SIGN_DOMAIN = utf8Encode("ghostly-turn");
const RELEASE_DOMAIN = utf8Encode("ghostly-turn-release");

const OFFSET = { version: 0, turn: 1, rev: 5, author: 8, active: 9, count: 10, slots: 11, instance: 203, releasePresent: 211, releaseFrom: 212, releaseTo: 213, releaseH: 214, releaseSignature: 246, signature: 310 } as const;
const SLOT_BYTES = 32 + TURN_NAME_BYTES;

/** What a holder of `D` derives for the turn: the identity the packet is published under, and the key that seals it. */
export interface TurnKeys {
  identity: Identity;
  /** The turn address: the identity's public key, 32 bytes. It is what both signatures in the body name. */
  address: Uint8Array;
  sealKey: Uint8Array;
}

/** The first device-set secret of a profile, from its DID key's seed (WISP 06 § Terms): every backup already carries that. */
export function firstDeviceSetSecret(didSeed: Uint8Array): Uint8Array {
  return hkdf(sha256, didSeed, SALT, utf8Encode("device-set"), 32);
}

/** The turn's keys under the device-set secret `D` (32 bytes). */
export function turnKeys(d: Uint8Array): TurnKeys {
  if (d.length !== 32) throw new Error("The device-set secret is 32 bytes");
  const identity = identityFromSeed(hkdf(sha256, d, SALT, utf8Encode("turn"), 32));
  return { identity, address: identity.publicKey, sealKey: hkdf(sha256, d, SALT, utf8Encode("turn-seal"), 32) };
}

/** The BEP44 sequence number of an ordinary record: not the clock. Two devices never sign an equal one, each has its slot in the low bits. */
export function turnSequence(turn: number, rev: number, author: number): number {
  if (!Number.isInteger(turn) || turn < 0 || turn > TURN_MAX) throw new Error("A turn is at most 2^32 - 2");
  if (!Number.isInteger(rev) || rev < 0 || rev >= TURN_REV_LIMIT) throw new Error("A rev is under 2^18");
  if (!Number.isInteger(author) || author < 0 || author >= TURN_SLOTS) throw new Error("An author is a slot, 0 to 3");
  return turn * 2 ** 20 + rev * 4 + author;
}

export interface TurnSlot {
  /** The device signing key (Ed25519 public key, 32 bytes). */
  key: Uint8Array;
  /** At most 16 bytes of UTF-8. */
  name: string;
}

export interface TurnRelease {
  /** The slot of the device that gave the turn up. */
  from: number;
  /** The slot of the device it was given to. */
  to: number;
  /** `H`, the digest of the state handed over (32 bytes). */
  h: Uint8Array;
  /** `from`'s signature (`turnReleaseMessage`). */
  signature: Uint8Array;
}

/** What a record says, before its author signs it. */
export interface TurnFields {
  turn: number;
  rev: number;
  /** The slot of the device that signs this record. */
  author: number;
  /** The slot of the active device; `TURN_NO_ACTIVE` in a tombstone. */
  active: number;
  /** By slot, four entries; null for a slot nobody holds. */
  slots: (TurnSlot | null)[];
  /** 8 random bytes, made by the active device each time its engine starts. */
  instance: Uint8Array;
  release?: TurnRelease;
}

/** A record as read: its fields, its sequence number, and the body's bytes. */
export interface TurnRecord extends TurnFields {
  tombstone: boolean;
  sequence: number;
  signature: Uint8Array;
  body: Uint8Array;
}

/** Signs with a device signing key. Asynchronous: where WebCrypto holds the key, the app has no seed to sign with. */
export type TurnSigner = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Why the reader refuses a record. Each one is a rule of WISP 06 § Record. */
export type TurnRefusal =
  | "packet" // not a BEP44 packet under the turn key
  | "label" // not exactly one TXT record under `_s`
  | "seal" // does not open under the seal key
  | "length" | "version" | "turn" | "rev" | "author" | "active" | "count" | "slots" | "name" | "release-layout" // an inconsistent layout
  | "tombstone" // a tombstone that is not shaped as one, or an ordinary record that is
  | "author-not-active" // written by a device other than the one it names active
  | "signature" // not signed by the key in its own slot `author`
  | "release" // a release that does not verify, or names another turn or device
  | "sequence"; // a sequence number that is not the formula's

export class TurnRecordError extends Error {
  constructor(readonly refusal: TurnRefusal, detail?: string) {
    super(`The turn record is not valid: ${detail ?? refusal}`);
    this.name = "TurnRecordError";
  }
}

const refuse = (refusal: TurnRefusal, detail?: string): never => { throw new TurnRecordError(refusal, detail); };
const isZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

/**
 * A device's name as its slot holds it: UTF-8, cut at a character boundary to 16 bytes, and with no NUL (the padding).
 * A character is what a person sees as one (a grapheme), so a cut never leaves half an emoji or a lone joiner.
 */
export function turnName(name: string): string {
  const clean = name.replace(/\0/g, "");
  const Segmenter = typeof Intl === "undefined" ? undefined
    : (Intl as unknown as { Segmenter?: new (locale: undefined, options: { granularity: "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
  const characters = Segmenter ? Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(clean), (s) => s.segment) : Array.from(clean);
  let out = "", length = 0;
  for (const character of characters) {
    const size = utf8Encode(character).length;
    if (length + size > TURN_NAME_BYTES) break;
    out += character;
    length += size;
  }
  return out;
}

function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

/** What a release signs: `"ghostly-turn-release" || turnAddress(32) || turn(4) || toKey(32) || H(32)`. */
export function turnReleaseMessage(address: Uint8Array, turn: number, toKey: Uint8Array, h: Uint8Array): Uint8Array {
  if (address.length !== 32 || toKey.length !== 32 || h.length !== 32) throw new Error("A release names 32-byte values");
  return concatBytes(RELEASE_DOMAIN, address, u32(turn), toKey, h);
}

/** What the author signs: `"ghostly-turn" || turnAddress(32) || body[0..310]`. */
export function turnSignedMessage(address: Uint8Array, unsigned: Uint8Array): Uint8Array {
  return concatBytes(SIGN_DOMAIN, address, unsigned.subarray(0, TURN_SIGNED_BYTES));
}

/** The first 310 bytes of the body. Throws on fields that no record may hold; the reader's rules are `readTurnBody`'s. */
export function encodeTurnFields(fields: TurnFields): Uint8Array {
  const tombstone = fields.turn === TOMBSTONE_TURN;
  if (!Number.isInteger(fields.turn) || fields.turn < 0 || fields.turn > TOMBSTONE_TURN) throw new Error("A turn is at most 2^32 - 1");
  if (!Number.isInteger(fields.rev) || fields.rev < 0 || fields.rev >= TURN_REV_LIMIT) throw new Error("A rev is under 2^18");
  if (fields.slots.length !== TURN_SLOTS) throw new Error("A record has four slots");
  if (fields.instance.length !== 8) throw new Error("An instance is 8 bytes");
  const held = (slot: number) => Number.isInteger(slot) && slot >= 0 && slot < TURN_SLOTS && !!fields.slots[slot];
  if (!held(fields.author)) throw new Error("The author has no slot");
  if (tombstone ? fields.active !== TURN_NO_ACTIVE : !held(fields.active)) throw new Error(tombstone ? "A tombstone names no active device" : "The active device has no slot");
  const body = new Uint8Array(TURN_SIGNED_BYTES);
  body[OFFSET.version] = TURN_VERSION;
  body.set(u32(fields.turn), OFFSET.turn);
  body.set(u32(fields.rev).subarray(1), OFFSET.rev);
  body[OFFSET.author] = fields.author;
  body[OFFSET.active] = fields.active;
  body[OFFSET.count] = fields.slots.filter(Boolean).length;
  fields.slots.forEach((slot, i) => {
    if (!slot) return;
    if (slot.key.length !== 32 || isZero(slot.key)) throw new Error("A device signing key is 32 bytes, not all zero");
    const name = utf8Encode(slot.name);
    if (name.length > TURN_NAME_BYTES || name.includes(0)) throw new Error("A device name is at most 16 bytes (see turnName)");
    body.set(slot.key, OFFSET.slots + i * SLOT_BYTES);
    body.set(name, OFFSET.slots + i * SLOT_BYTES + 32);
  });
  body.set(fields.instance, OFFSET.instance);
  const release = fields.release;
  if (release) {
    if (!held(release.from) || !held(release.to)) throw new Error("A release names two devices of the set");
    if (release.h.length !== 32 || release.signature.length !== 64) throw new Error("A release holds a 32-byte digest and a 64-byte signature");
    body[OFFSET.releasePresent] = 1;
    body[OFFSET.releaseFrom] = release.from;
    body[OFFSET.releaseTo] = release.to;
    body.set(release.h, OFFSET.releaseH);
    body.set(release.signature, OFFSET.releaseSignature);
  }
  return body;
}

/** A release of `turn` to the device whose key is `toKey`, signed by the device that gives the turn up. */
export async function signTurnRelease(address: Uint8Array, turn: number, from: number, to: number, toKey: Uint8Array, h: Uint8Array, signer: TurnSigner): Promise<TurnRelease> {
  return { from, to, h, signature: await signer(turnReleaseMessage(address, turn, toKey, h)) };
}

/** The whole body, 374 bytes: the fields and the author's signature over them. */
export async function signTurnBody(address: Uint8Array, fields: TurnFields, signer: TurnSigner): Promise<Uint8Array> {
  const unsigned = encodeTurnFields(fields);
  const signature = await signer(turnSignedMessage(address, unsigned));
  if (signature.length !== 64) throw new Error("A signature is 64 bytes");
  return concatBytes(unsigned, signature);
}

/**
 * A body as a record, or a `TurnRecordError` naming the rule it breaks (WISP 06 § Record, "A reader accepts a record
 * that..."). What depends on what the reader already holds (a sequence not lower than its own, the release's `from`
 * against the device that was active before) is the caller's: `turnRead.ts`.
 */
export function readTurnBody(body: Uint8Array, address: Uint8Array): TurnRecord {
  if (body.length !== TURN_BODY_BYTES) refuse("length");
  if (body[OFFSET.version] !== TURN_VERSION) refuse("version");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const turn = view.getUint32(OFFSET.turn);
  const rev = (body[OFFSET.rev] << 16) | (body[OFFSET.rev + 1] << 8) | body[OFFSET.rev + 2];
  if (rev >= TURN_REV_LIMIT) refuse("rev");
  const author = body[OFFSET.author], active = body[OFFSET.active], count = body[OFFSET.count];
  if (author >= TURN_SLOTS) refuse("author");
  if (active >= TURN_SLOTS && active !== TURN_NO_ACTIVE) refuse("active");
  if (count > TURN_SLOTS) refuse("count");

  const slots: (TurnSlot | null)[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < TURN_SLOTS; i++) {
    const at = OFFSET.slots + i * SLOT_BYTES;
    const key = body.slice(at, at + 32), padded = body.subarray(at + 32, at + SLOT_BYTES);
    if (isZero(key)) {
      // An unused slot is zero, name and all.
      if (!isZero(padded)) refuse("slots");
      slots.push(null);
      continue;
    }
    const end = padded.indexOf(0);
    const name = end < 0 ? padded : padded.subarray(0, end);
    if (end >= 0 && !isZero(padded.subarray(end))) refuse("name");
    let text = "";
    try { text = decoder.decode(name); } catch { refuse("name"); }
    if (slots.some((other) => other && bytesEqual(other.key, key))) refuse("slots", "one key in two slots");
    slots.push({ key, name: text });
  }
  if (slots.filter(Boolean).length !== count) refuse("count");
  const authorSlot = slots[author];
  if (!authorSlot) return refuse("author");

  const tombstone = turn === TOMBSTONE_TURN;
  if (tombstone !== (active === TURN_NO_ACTIVE)) refuse("tombstone");
  if (!tombstone) {
    if (!slots[active]) refuse("active");
    // A record is written by the device it names active: a holder of `D` cannot add a slot under someone else's turn.
    if (author !== active) refuse("author-not-active");
  }

  const present = body[OFFSET.releasePresent];
  if (present > 1) refuse("release-layout");
  let release: TurnRelease | undefined;
  if (!present) {
    if (!isZero(body.subarray(OFFSET.releaseFrom, OFFSET.signature))) refuse("release-layout");
  } else {
    if (tombstone) refuse("tombstone", "a tombstone carries no release");
    const from = body[OFFSET.releaseFrom], to = body[OFFSET.releaseTo];
    const fromSlot = from < TURN_SLOTS ? slots[from] : null, toSlot = to < TURN_SLOTS ? slots[to] : null;
    if (!fromSlot || !toSlot) return refuse("release-layout");
    release = { from, to, h: body.slice(OFFSET.releaseH, OFFSET.releaseSignature), signature: body.slice(OFFSET.releaseSignature, OFFSET.signature) };
    if (to !== active) refuse("release", "the release is to another device than the active one");
    if (!verify(release.signature, turnReleaseMessage(address, turn, toSlot.key, release.h), fromSlot.key)) refuse("release");
  }

  const signature = body.slice(OFFSET.signature);
  if (!verify(signature, turnSignedMessage(address, body), authorSlot.key)) refuse("signature");
  return {
    turn, rev, author, active, slots, instance: body.slice(OFFSET.instance, OFFSET.releasePresent), ...(release ? { release } : {}),
    tombstone, sequence: tombstone ? TOMBSTONE_SEQUENCE : turnSequence(turn, rev, author), signature, body: body.slice(),
  };
}

/** The TXT value: base64url of `nonce(24) || XSalsa20-Poly1305(sealKey, nonce, body)`. */
export function sealTurnBody(body: Uint8Array, sealKey: Uint8Array, nonce: Uint8Array = randomBytes(24)): string {
  if (body.length !== TURN_BODY_BYTES) throw new Error("A turn record's body is 374 bytes");
  if (nonce.length !== 24) throw new Error("A nonce is 24 bytes");
  return toBase64Url(concatBytes(nonce, xsalsa20poly1305(sealKey, nonce).encrypt(body)));
}

/** The body inside a TXT value, or null when it does not open under the seal key. */
export function openTurnValue(value: string, sealKey: Uint8Array): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let sealed: Uint8Array;
  try { sealed = fromBase64Url(value); } catch { return null; }
  if (sealed.length !== TURN_SEALED_BYTES) return null;
  try { return xsalsa20poly1305(sealKey, sealed.subarray(0, 24)).decrypt(sealed.subarray(24)); } catch { return null; }
}

/**
 * The packet of a signed body, as a relay payload (`signature(64) || sequence(8) || DNS packet`): sealed once, signed
 * under the turn key at the record's own sequence. These are the bytes a device stores and puts, unchanged, every time.
 */
export function turnPacket(keys: TurnKeys, body: Uint8Array, nonce?: Uint8Array): Uint8Array {
  const record = readTurnBody(body, keys.address);
  const dns = encodeTxtPacket([{ name: `${TURN_LABEL}.${keys.identity.pubKeyZ32}`, value: sealTurnBody(body, keys.sealKey, nonce), ttl: TURN_TTL }]);
  return signRelayPayload(keys.identity, dns, BigInt(record.sequence));
}

/** Signs and seals a record: its packet, to be stored before it is put. */
export async function signTurnPacket(keys: TurnKeys, fields: TurnFields, signer: TurnSigner, nonce?: Uint8Array): Promise<Uint8Array> {
  return turnPacket(keys, await signTurnBody(keys.address, fields, signer), nonce);
}

/**
 * A packet read at the turn address.
 * - `valid`: a record every rule accepts.
 * - `invalid`: a BEP44 packet under the turn key (a node stores it, so its sequence counts as seen) that is no valid record.
 * - `foreign`: not a packet under the turn key at all. No honest source holds it, and nothing of it counts.
 */
export type TurnPacketRead =
  | { kind: "valid"; sequence: bigint; record: TurnRecord }
  | { kind: "invalid"; sequence: bigint; refusal: TurnRefusal }
  | { kind: "foreign" };

/** Verifies and opens one packet. Never throws. */
export function readTurnPacket(keys: TurnKeys, payload: Uint8Array): TurnPacketRead {
  let sequence: bigint, dns: Uint8Array;
  try { ({ seq: sequence, dnsPacket: dns } = openRelayPayload(keys.identity.pubKeyZ32, payload)); } catch { return { kind: "foreign" }; }
  const invalid = (refusal: TurnRefusal): TurnPacketRead => ({ kind: "invalid", sequence, refusal });
  let value: string;
  try {
    const records = decodeTxtPacket(dns);
    if (records.length !== 1 || records[0].name !== `${TURN_LABEL}.${keys.identity.pubKeyZ32}`) return invalid("label");
    value = records[0].value;
  } catch { return invalid("label"); }
  const body = openTurnValue(value, keys.sealKey);
  if (!body) return invalid("seal");
  let record: TurnRecord;
  try { record = readTurnBody(body, keys.address); } catch (error) { return invalid(error instanceof TurnRecordError ? error.refusal : "length"); }
  // The sequence a node sorts by must be the one the body gives: otherwise a record could be put above its own turn.
  if (sequence !== BigInt(record.sequence)) return invalid("sequence");
  return { kind: "valid", sequence, record };
}

/** The sequence number of a relay payload, read without verifying it: bytes 64 to 72. Null when it is too short. */
export function turnPayloadSequence(payload: Uint8Array): bigint | null {
  if (payload.length < 72) return null;
  return new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0);
}

/**
 * The `turn` and `rev` of the next record a device writes in its slot `author` at `turn`, above everything ever seen
 * at the address: above its own last record there (`lastRev` plus one; null when it wrote none in this turn), and
 * above the highest raw sequence `seen`, valid or not, so an invalid record with a high `rev` never makes its put
 * fail as older. `raised` says the turn itself had to rise: `rev` ran out, or something was seen above this turn. A
 * device that is not taking the turn then writes it with a release from itself to itself. Null when nothing can be
 * written any more (something at or above the last ordinary turn was seen).
 */
export function nextTurnPosition(turn: number, lastRev: number | null, author: number, seen: bigint | number): { turn: number; rev: number; raised: boolean } | null {
  let next = { turn, rev: lastRev === null ? 0 : lastRev + 1 };
  if (next.rev >= TURN_REV_LIMIT) next = { turn: turn + 1, rev: 0 };
  const above = BigInt(seen);
  if (BigInt(next.turn) * 2n ** 20n + BigInt(next.rev * 4 + author) <= above) {
    // The lowest position of this slot above what was seen.
    const seenTurn = above / 2n ** 20n, low = Number(above % 2n ** 20n);
    if (seenTurn > BigInt(TURN_MAX)) return null;
    next = { turn: Number(seenTurn), rev: Math.floor(low / 4) + (low % 4 >= author ? 1 : 0) };
    if (next.rev >= TURN_REV_LIMIT) next = { turn: next.turn + 1, rev: 0 };
  }
  if (next.turn > TURN_MAX) return null;
  return { ...next, raised: next.turn !== turn };
}
