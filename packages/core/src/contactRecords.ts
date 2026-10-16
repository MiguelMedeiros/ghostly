import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Decode, utf8Encode } from "./bytes";
import { identityFromSeed, identityFromSeedB64, publicKeyFromZ32, type Identity } from "./identity";
import { readInviteCode } from "./invite";
import { measureRecords, type GhostRecord } from "./pkarr";
import { hasVisible, stripHidden } from "./text";

/*
 * The three records of a contact link (WISP 8xx § Records): the owner's link record under the link key, the four knock
 * slots every holder of the link writes, and a request under the requester's own asker key, sealed to the link key.
 * Pure functions: who publishes, reads and when is the engine's.
 */

export const LINK_RECORD_LABEL = "_cl";
export const KNOCK_SLOT_LABEL = "_knock";
export const REQUEST_LABEL = "_req";
/** Every record of a contact link carries this TTL: readers never read it. */
export const CONTACT_RECORD_TTL = 300;
export const KNOCK_SLOTS = 4;
export const MAX_SLOT_KNOCKS = 6;
export const MAX_SEEN = 32;
export const STAMP_BITS_DEFAULT = 18;
export const STAMP_BITS_MIN = 16;
export const STAMP_BITS_MAX = 24;
export const REQUEST_NAME_UNITS = 48;
export const REQUEST_TEXT_BYTES = 200;
export const REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** How far ahead of the owner's clock a request may be dated: two devices' clocks are often minutes apart. */
export const REQUEST_CLOCK_SKEW_MS = 10 * 60_000;
/** A request's packet, as a WISP 403 envelope's: 8 bytes under the DHT's 1,000. */
export const REQUEST_PACKET_BYTES = 992;
const DAY_MS = 86_400_000;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const Z32_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const SEEN_ENTRY = /^[A-Za-z0-9_-]{12}$/;

export type LinkState = "open" | "busy" | "off";
/** What the owner says under the link key: everyone with the link may read it. */
export interface LinkRecord {
  state: LinkState;
  bits: number;
  /** The `seen` entries of the requests taken, newest first. */
  seen: string[];
}

/** One knock: an asker key, the UTC day its stamp was made for, and the stamp. */
export interface ContactKnock {
  key: string;
  day: number;
  stamp: number;
}

/** What a request says. `invite` is the requester's own `ghostly1p…` code: accepting is joining it. */
export interface ContactRequest {
  invite: string;
  name: string;
  text: string;
  issued: number;
  expires: number;
}

/** Why a request cannot be sent as it is: the person changes something and tries again. */
export type ContactRequestProblem = "name" | "text" | "invite" | "dates" | "too-long";

export class ContactRequestError extends Error {
  constructor(readonly problem: ContactRequestProblem) {
    super(`The request cannot be sent: ${problem}`);
    this.name = "ContactRequestError";
  }
}

const label = (text: string) => utf8Encode(text);

function derive(linkKeyZ32: string, info: string): Uint8Array {
  return hkdf(sha256, publicKeyFromZ32(linkKeyZ32), label("ghostly-contact/1"), label(info), 32);
}

/** The UTC day number of a time: a stamp is made for one. */
export function contactDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// --- The link record ------------------------------------------------------------------------------------------------

/** The `seen` entry of an asker key on a link: the first 9 bytes of a hash, so the record names nobody. */
export function seenEntry(linkKeyZ32: string, askerZ32: string): string {
  return toBase64Url(sha256(concatBytes(label("ghostly-contact/1 seen"), publicKeyFromZ32(linkKeyZ32), publicKeyFromZ32(askerZ32))).slice(0, 9));
}

export function linkRecords(record: LinkRecord): GhostRecord[] {
  if (!Number.isInteger(record.bits) || record.bits < STAMP_BITS_MIN || record.bits > STAMP_BITS_MAX) throw new Error("A link asks for 16 to 24 bits");
  return [{ label: LINK_RECORD_LABEL, value: JSON.stringify([1, record.state, record.bits, record.seen.slice(0, MAX_SEEN)]), ttl: CONTACT_RECORD_TTL }];
}

/** The link record, or null for anything that is not one. Elements after the fourth are a later revision's: ignored. */
export function readLinkRecord(records: GhostRecord[]): LinkRecord | null {
  const value = records.find(r => r.label === LINK_RECORD_LABEL)?.value;
  if (!value || value.length > 900) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed[0] !== 1) return null;
    const [, state, bits, seen] = parsed as unknown[];
    if (state !== "open" && state !== "busy" && state !== "off") return null;
    if (!Number.isInteger(bits) || (bits as number) < STAMP_BITS_MIN || (bits as number) > STAMP_BITS_MAX) return null;
    if (!Array.isArray(seen) || seen.length > MAX_SEEN || !seen.every(e => typeof e === "string" && SEEN_ENTRY.test(e))) return null;
    return { state, bits: bits as number, seen: seen as string[] };
  } catch { return null; }
}

// --- The stamp ------------------------------------------------------------------------------------------------------

function stampPrefix(linkKeyZ32: string, askerZ32: string, day: number): Uint8Array {
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, day);
  return concatBytes(label("ghostly-contact/1 stamp"), publicKeyFromZ32(linkKeyZ32), publicKeyFromZ32(askerZ32), tail);
}

function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function stampBytes(stamp: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, stamp);
  return bytes;
}

/** Whether `stamp` has at least `bits` zero bits for this link, asker key and day. */
export function stampHolds(linkKeyZ32: string, askerZ32: string, day: number, stamp: number, bits: number): boolean {
  if (!Number.isInteger(stamp) || stamp < 0 || stamp > 0xffffffff || !Number.isInteger(day) || day < 0 || day > 0xffffffff) return false;
  return leadingZeroBits(sha256(concatBytes(stampPrefix(linkKeyZ32, askerZ32, day), stampBytes(stamp)))) >= bits;
}

/** The first stamp with `bits` zero bits: about 2^bits hashes, once per day and link. */
export function makeStamp(linkKeyZ32: string, askerZ32: string, day: number, bits: number): number {
  const base = sha256.create().update(stampPrefix(linkKeyZ32, askerZ32, day));
  for (let stamp = 0; stamp <= 0xffffffff; stamp++) {
    if (leadingZeroBits(base.clone().update(stampBytes(stamp)).digest()) >= bits) return stamp;
  }
  throw new Error("No stamp");
}

/** The owner's check of a knock: a stamp for today or yesterday by its clock, with the bits its link asks for now. */
export function knockHolds(linkKeyZ32: string, knock: ContactKnock, bits: number, now: number): boolean {
  const today = contactDay(now);
  return (knock.day === today || knock.day === today - 1) && stampHolds(linkKeyZ32, knock.key, knock.day, knock.stamp, bits);
}

// --- The knock slots ------------------------------------------------------------------------------------------------

/** Slot `index`'s Pkarr identity: every holder of the link derives it. */
export function knockSlotIdentity(linkKeyZ32: string, index: number): Identity {
  if (!Number.isInteger(index) || index < 0 || index >= KNOCK_SLOTS) throw new Error("A link has four knock slots");
  return identityFromSeed(derive(linkKeyZ32, `knock seed ${index}`));
}

/** The slot an asker key knocks in. */
export function knockSlotOf(linkKeyZ32: string, askerZ32: string): number {
  return sha256(concatBytes(publicKeyFromZ32(linkKeyZ32), publicKeyFromZ32(askerZ32)))[0] % KNOCK_SLOTS;
}

export function knockSlotRecords(linkKeyZ32: string, knocks: ContactKnock[]): GhostRecord[] {
  const nonce = randomBytes(NONCE_LENGTH);
  const body = label(JSON.stringify(knocks.slice(-MAX_SLOT_KNOCKS).map(k => [k.key, k.day, k.stamp])));
  const box = xchacha20poly1305(derive(linkKeyZ32, "knock key"), nonce, publicKeyFromZ32(linkKeyZ32)).encrypt(body);
  return [{ label: KNOCK_SLOT_LABEL, value: toBase64Url(concatBytes(nonce, box)), ttl: CONTACT_RECORD_TTL }];
}

/** The knocks of a slot that open with the link's key and are well formed; a malformed entry is skipped, not the slot. */
export function readKnockSlot(linkKeyZ32: string, records: GhostRecord[]): ContactKnock[] {
  const value = records.find(r => r.label === KNOCK_SLOT_LABEL)?.value;
  if (!value || value.length > 900) return [];
  try {
    const bytes = fromBase64Url(value);
    const body = xchacha20poly1305(derive(linkKeyZ32, "knock key"), bytes.slice(0, NONCE_LENGTH), publicKeyFromZ32(linkKeyZ32)).decrypt(bytes.slice(NONCE_LENGTH));
    const parsed: unknown = JSON.parse(utf8Decode(body));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_SLOT_KNOCKS).flatMap(entry => Array.isArray(entry) && typeof entry[0] === "string" && Z32_KEY.test(entry[0])
      && Number.isSafeInteger(entry[1]) && entry[1] >= 0 && Number.isInteger(entry[2]) && entry[2] >= 0 && entry[2] <= 0xffffffff
      ? [{ key: entry[0], day: entry[1] as number, stamp: entry[2] as number }] : []);
  } catch { return []; }
}

/** The knocks to write: others' made today or yesterday (at most five, the latest), and mine last. */
export function mergeContactKnocks(existing: ContactKnock[], mine: ContactKnock, now: number): ContactKnock[] {
  const today = contactDay(now);
  const fresh = existing.filter(k => k.key !== mine.key && k.day >= today - 1 && k.day <= today + 1);
  return [...fresh.slice(-(MAX_SLOT_KNOCKS - 1)), mine];
}

// --- The request ----------------------------------------------------------------------------------------------------

function requestKey(linkKeyZ32: string, askerZ32: string, shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, label("ghostly-contact/1 request"), concatBytes(publicKeyFromZ32(linkKeyZ32), publicKeyFromZ32(askerZ32)), 32);
}

const REQUEST_AAD = label("ghostly-contact/1 request");

/** The value of a request's record for a plaintext of `length` bytes. */
const sealedValueLength = (length: number) => Math.ceil(((NONCE_LENGTH + length + TAG_LENGTH) * 4) / 3);

let plaintextBytes: number | undefined;
/** The size every request's plaintext is padded to: the largest whose packet fits `REQUEST_PACKET_BYTES`. */
export function requestPlaintextBytes(): number {
  if (plaintextBytes !== undefined) return plaintextBytes;
  const anyKey = "y".repeat(52);
  let length = REQUEST_PACKET_BYTES;
  while (measureRecords(anyKey, [{ label: REQUEST_LABEL, value: "A".repeat(sealedValueLength(length)), ttl: CONTACT_RECORD_TTL }]) > REQUEST_PACKET_BYTES) length--;
  return (plaintextBytes = length);
}

function nameHolds(name: unknown): name is string {
  return typeof name === "string" && name.length <= REQUEST_NAME_UNITS && name === name.trim() && stripHidden(name) === name && hasVisible(name);
}

function textHolds(text: unknown): text is string {
  if (typeof text !== "string" || !text.trim()) return false;
  return utf8Encode(text).length <= REQUEST_TEXT_BYTES;
}

function inviteHolds(invite: unknown): invite is string {
  if (typeof invite !== "string") return false;
  const reading = readInviteCode(invite);
  return reading.ok && reading.format === "ghostly1" && invite === invite.trim().toLowerCase() && invite.startsWith("ghostly1p");
}

/**
 * The request record the asker publishes under its own key. Throws `ContactRequestError` when the name, the text, the
 * invite or the dates break a bound, or when the whole does not fit the packet ("Shorten the message").
 */
export function requestRecords(askerSeedB64: string, linkKeyZ32: string, request: ContactRequest): GhostRecord[] {
  if (!nameHolds(request.name)) throw new ContactRequestError("name");
  if (!textHolds(request.text)) throw new ContactRequestError("text");
  if (!inviteHolds(request.invite)) throw new ContactRequestError("invite");
  if (!Number.isSafeInteger(request.issued) || !Number.isSafeInteger(request.expires) || request.expires <= request.issued
    || request.expires - request.issued > REQUEST_LIFETIME_MS) throw new ContactRequestError("dates");
  const asker = identityFromSeedB64(askerSeedB64);
  const json = label(JSON.stringify([1, request.invite, request.name, request.text, request.issued, request.expires]));
  const size = requestPlaintextBytes();
  if (json.length > size) throw new ContactRequestError("too-long");
  // Spaces after the JSON value, so every request is the same size whatever it says.
  const plaintext = new Uint8Array(size).fill(0x20);
  plaintext.set(json);
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(asker.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(linkKeyZ32)));
  const nonce = randomBytes(NONCE_LENGTH);
  const box = xchacha20poly1305(requestKey(linkKeyZ32, asker.pubKeyZ32, shared), nonce, REQUEST_AAD).encrypt(plaintext);
  return [{ label: REQUEST_LABEL, value: toBase64Url(concatBytes(nonce, box)), ttl: CONTACT_RECORD_TTL }];
}

/**
 * The owner's reading of the request under `askerZ32`, with the link's seed. Null, whole, for a request that does not
 * open, does not hold, or has expired by `now`. That the packet is signed by the asker key is the resolver's check.
 */
export function openRequest(linkSeedB64: string, askerZ32: string, records: GhostRecord[], now: number): ContactRequest | null {
  const value = records.find(r => r.label === REQUEST_LABEL)?.value;
  if (!value || value.length > sealedValueLength(requestPlaintextBytes()) + 4) return null;
  try {
    const link = identityFromSeedB64(linkSeedB64);
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(link.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(askerZ32)));
    const bytes = fromBase64Url(value);
    const plaintext = xchacha20poly1305(requestKey(link.pubKeyZ32, askerZ32, shared), bytes.slice(0, NONCE_LENGTH), REQUEST_AAD).decrypt(bytes.slice(NONCE_LENGTH));
    const parsed: unknown = JSON.parse(utf8Decode(plaintext));
    if (!Array.isArray(parsed) || parsed[0] !== 1) return null;
    const [, invite, name, text, issued, expires] = parsed as unknown[];
    if (!inviteHolds(invite) || !nameHolds(name) || !textHolds(text)) return null;
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)) return null;
    const [from, until] = [issued as number, expires as number];
    // Dated ahead of the owner's clock by more than two clocks drift apart: it would wait past its seven days.
    if (until <= from || until - from > REQUEST_LIFETIME_MS || until <= now || from > now + REQUEST_CLOCK_SKEW_MS) return null;
    return { invite, name, text, issued: from, expires: until };
  } catch { return null; }
}
