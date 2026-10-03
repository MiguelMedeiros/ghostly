import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { bytesEqual, concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { verify } from "./identity";
import type { DeviceFrame } from "./deviceLink";
import { DEVICE_KINDS, type DeviceKind } from "./enroll";
import type { Signer } from "./signer";
import { TURN_MAX } from "./turnRecord";

/*
 * `handoff/1` (WISP 06 § The handoff): the frames two of a person's devices exchange to move a profile from the active
 * one (A, the giver) to another (B, the taker), and what both sides compute from them. Nothing here touches storage or
 * the network: `packages/browser/src/devices/handoff*.ts` runs the two sides.
 *
 * What this build adds to the WISP's frames, all additive (an older device drops a frame it does not know):
 *
 * - `handoff-data` and `handoff-ack`: the bytes of a part, in sealed pieces, and how many of them the taker wrote. The
 *   WISP has parts travel as files of WISP 501; a device link carries no chat's file transfer (its consent, its desk),
 *   so a part goes as pieces of at most `HANDOFF_PIECE_BYTES`, each sealed alone with the stream key, at most
 *   `HANDOFF_WINDOW` unconfirmed at a time. A dropped link resumes from the confirmed bytes (`handoff-have`, `p`).
 * - `handoff-have` carries the digests inline (`d`, base64url), in as many frames as it takes (`more`), and the parts
 *   received in part (`p`: name to confirmed bytes). The WISP has it as a part of 32-byte digests.
 * - `handoff-manifest` may be split the same way, says which file ids each digest is (`ids`, so the taker writes
 *   each file once under the id its records name) and which files stay behind for later (`later`).
 * - `handoff-hello` says the taker's limit for files left for later (`later`, bytes; 0: none), and names the handoff
 *   (`id`) when it goes on in a new session.
 * - `handoff-pake` frame 3 carries `c`, the proof of the context (see `handoffContext`), and `wrong` when the taker
 *   found the password wrong (so the giver counts it at once rather than at its timeout).
 *
 * A session's stream key: `HKDF-SHA256(ikm = X25519(e_A, e_B) || K, salt = the session's transcript hash (32 bytes),
 * info = "ghostly-handoff-stream/1", 32)`. `K` is the password proof's key on a pull's first session and empty on a
 * push's. A handoff outlives a session (a dropped link; the giver's own reload into the gate before pass 2, which
 * makes a new session certain), so on every later session of the same handoff `K` is the first session's stream key,
 * which both sides keep durably for that handoff: the password is proven once, and every session's key still comes
 * from a fresh exchange bound to that session.
 */

export const HANDOFF_HELLO = "handoff-hello";
export const HANDOFF_REQUEST = "handoff-request";
export const HANDOFF_OFFER = "handoff-offer";
export const HANDOFF_BUSY = "handoff-busy";
export const HANDOFF_PAKE = "handoff-pake";
export const HANDOFF_HAVE = "handoff-have";
export const HANDOFF_MANIFEST = "handoff-manifest";
export const HANDOFF_DATA = "handoff-data";
export const HANDOFF_ACK = "handoff-ack";
export const HANDOFF_VERIFIED = "handoff-verified";
export const HANDOFF_RELEASE = "handoff-release";
export const HANDOFF_DONE = "handoff-done";
export const HANDOFF_CANCEL = "handoff-cancel";
export const HANDOFF_FILE_REQUEST = "handoff-file-request";
export const HANDOFF_FILE_MISSING = "handoff-file-missing";

/** The version `handoff-hello` says. */
export const HANDOFF_VERSION = 1;

/** The WISP's timeouts (§ States and events), in one place. */
export const HANDOFF_TIMINGS = {
  /** The taker: no session with the giver within this long. */
  connectMs: 30_000,
  /** The giver: the proof held, and no frame came for this long. Also a frame of the proof that never comes. */
  idleMs: 60_000,
  /** Pass 1: no confirmed bytes for this long, or the link dropped: paused. */
  stallMs: 120_000,
  /** Pass 1 gives up after this long paused. */
  giveUpMs: 24 * 60 * 60_000,
  /** Quiesce waits this long for a payment that is going through. */
  paymentMs: 30_000,
  /** Pass 2: no `handoff-verified` within this long of the last part: the giver is active again. */
  verifiedMs: 10 * 60_000,
  /** The taker, verified: no release within this long. It reads the turn and asks again. */
  releaseMs: 60_000,
  /** A staging namespace that was not installed is dropped after this long at the latest. */
  stagingMs: 24 * 60 * 60_000,
} as const;

/** One piece of a part, before it is sealed. Sealed and in base64url it fits a device frame (60 KiB). */
export const HANDOFF_PIECE_BYTES = 32 * 1024;
/** Pieces sent and not yet confirmed, at most. */
export const HANDOFF_WINDOW = 16;
/** "Bring large files later" on mobile data: files over this size stay behind (WISP 06 § User experience). */
export const HANDOFF_LATER_BYTES = 16 * 1024 * 1024;
/** Entries per `handoff-manifest` or `handoff-have` frame. */
export const HANDOFF_LIST_PER_FRAME = 300;

/** Why a giver says it cannot hand over now (`handoff-busy`). */
export const HANDOFF_BUSY_REASONS = ["handoff", "payment", "call", "locked-out", "refused", "wallet", "older", "offline"] as const;
export type HandoffBusyReason = (typeof HANDOFF_BUSY_REASONS)[number];

/** Why a side ended a handoff (`handoff-cancel`). */
export const HANDOFF_CANCEL_REASONS = ["cancelled", "damaged", "room", "version", "timeout", "failed", "turn", "password"] as const;
export type HandoffCancelReason = (typeof HANDOFF_CANCEL_REASONS)[number];

const KEY = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = KEY;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const B64 = /^[A-Za-z0-9_-]*$/;
const HEX = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^[0-9A-Za-z.+_-]{1,40}$/;
/** A part's name (WISP 06 § Frames): `db/<store>`, `local`, `file/<sha256>`, `wallet/<type>/<name>`, `devices`. */
const PART = /^(db\/[A-Za-z0-9_-]{1,64}|local|devices|file\/[A-Za-z0-9_-]{43}|wallet\/[a-z0-9-]{1,32}\/[A-Za-z0-9_.-]{1,100})$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** The largest part the reader accepts: a file of WISP 501 has no limit beneath this. */
const MAX_PART = 2 ** 50;

const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const isText = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);

/** One part as a manifest and `H` name it: its name, its size in bytes and its SHA-256 (base64url). */
export type HandoffPart = [name: string, size: number, sha256: string];

export const isHandoffPartName = (name: unknown): name is string => typeof name === "string" && PART.test(name);
/** The part a file is: `file/<its SHA-256, base64url>`. */
export const filePartName = (sha256B64: string): string => `file/${sha256B64}`;
/** The digest a file part names, or null for any other part. */
export const filePartDigest = (name: string): string | null => (name.startsWith("file/") && DIGEST.test(name.slice(5)) ? name.slice(5) : null);

function isPart(value: unknown): value is HandoffPart {
  return Array.isArray(value) && value.length === 3 && isHandoffPartName(value[0]) && isCount(value[1], MAX_PART) && isText(value[2], DIGEST)
    // A file part's name is its digest.
    && (filePartDigest(value[0]) === null || filePartDigest(value[0]) === value[2]);
}

/** Names compared as UTF-8 byte strings, as `H` sorts them. */
function compareNames(a: string, b: string): number {
  const x = utf8Encode(a), y = utf8Encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Parts sorted by name as byte strings, with one entry per name: what `H` and a manifest list. */
export function sortParts(parts: readonly HandoffPart[]): HandoffPart[] {
  const byName = new Map<string, HandoffPart>();
  for (const part of parts) {
    const seen = byName.get(part[0]);
    if (seen && (seen[1] !== part[1] || seen[2] !== part[2])) throw new Error(`Two different parts are named ${part[0]}`);
    byName.set(part[0], [part[0], part[1], part[2]]);
  }
  return [...byName.values()].sort((a, b) => compareNames(a[0], b[0]));
}

/**
 * `H`, the digest of the state handed over (WISP 06 § Frames): SHA-256 of the UTF-8 bytes of
 * `JSON.stringify(["ghostly-handoff/1", N + 1, fromKey, toKey, parts])`, where `parts` is every part of both passes
 * and every part the taker already held and keeps, as `[name, size, sha256]` sorted by name. Keys are base64url.
 */
export function handoffDigest(turn: number, fromKey: Uint8Array, toKey: Uint8Array, parts: readonly HandoffPart[]): Uint8Array {
  if (!isCount(turn, TURN_MAX)) throw new Error("A turn is at most 2^32 - 2");
  if (fromKey.length !== 32 || toKey.length !== 32) throw new Error("A device signing key is 32 bytes");
  for (const part of parts) if (!isPart(part)) throw new Error("A part is [name, size, sha256]");
  return sha256(utf8Encode(JSON.stringify(["ghostly-handoff/1", turn, toBase64Url(fromKey), toBase64Url(toKey), sortParts(parts)])));
}

/** What `handoff-verified` signs: `["ghostly-handoff-verified", turnAddress, N + 1, H]`, the bytes in base64url. */
export function handoffVerifiedMessage(turnAddress: Uint8Array, turn: number, h: Uint8Array): Uint8Array {
  if (turnAddress.length !== 32 || h.length !== 32) throw new Error("A turn address and H are 32 bytes");
  if (!isCount(turn, TURN_MAX)) throw new Error("A turn is at most 2^32 - 2");
  return utf8Encode(JSON.stringify(["ghostly-handoff-verified", toBase64Url(turnAddress), turn, toBase64Url(h)]));
}

/**
 * The context the password proof is bound to (WISP 06 § Authorizing a handoff): `"ghostly-handoff/1" || turnAddress ||
 * A's key || B's key || the session's transcript hash` (32 bytes, from its hex).
 */
export function handoffContext(turnAddress: Uint8Array, giverKey: Uint8Array, takerKey: Uint8Array, transcriptHash: string): Uint8Array {
  if (turnAddress.length !== 32 || giverKey.length !== 32 || takerKey.length !== 32) throw new Error("The context names 32-byte keys");
  if (!HEX.test(transcriptHash)) throw new Error("A transcript hash is 64 lower-case hex digits");
  return concatBytes(utf8Encode("ghostly-handoff/1"), turnAddress, giverKey, takerKey, hexToBytes(transcriptHash));
}

/**
 * The proof that the password proof's key was made in this context: HMAC-SHA256 under that key. The OPAQUE library
 * this build uses takes no context of its own (its identifiers go into the envelope at registration, and cannot carry
 * a session), so the taker sends this beside the third message, and the giver checks it.
 */
export function handoffContextProof(pakeKey: Uint8Array, context: Uint8Array): Uint8Array {
  return hmac(sha256, pakeKey, concatBytes(utf8Encode("ghostly-handoff-context/1"), context));
}

/** A fresh X25519 key pair for one session of a handoff: the secret stays in memory, the public key goes in `handoff-hello`. */
export function handoffEphemeral(secret: Uint8Array = randomBytes(32)): { secret: Uint8Array; publicKey: Uint8Array } {
  if (secret.length !== 32) throw new Error("An X25519 secret is 32 bytes");
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

/** A session's stream key (see the top of this file). `k`: the password proof's key, the handoff's first stream key, or empty. */
export function handoffStreamKey(ownSecret: Uint8Array, peerPublic: Uint8Array, k: Uint8Array, transcriptHash: string): Uint8Array {
  if (peerPublic.length !== 32) throw new Error("An X25519 public key is 32 bytes");
  if (!HEX.test(transcriptHash)) throw new Error("A transcript hash is 64 lower-case hex digits");
  let shared: Uint8Array;
  // A key of low order makes no shared secret (the library refuses an all-zero one).
  try { shared = x25519.getSharedSecret(ownSecret, peerPublic); } catch { throw new Error("The other device's key is not a key"); }
  if (shared.every((b) => b === 0)) throw new Error("The other device's key is not a key");
  return hkdf(sha256, concatBytes(shared, k), hexToBytes(transcriptHash), utf8Encode("ghostly-handoff-stream/1"), 32);
}

/** One piece sealed with the stream key: `nonce(24) || XSalsa20-Poly1305(key, nonce, piece)`, a random nonce each. */
export function sealHandoffPiece(key: Uint8Array, piece: Uint8Array, nonce: Uint8Array = randomBytes(24)): Uint8Array {
  if (key.length !== 32 || nonce.length !== 24) throw new Error("A stream key is 32 bytes and a nonce 24");
  return concatBytes(nonce, xsalsa20poly1305(key, nonce).encrypt(piece));
}

/** A sealed piece opened, or null when it was not sealed with this key or was changed. */
export function openHandoffPiece(key: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (key.length !== 32 || sealed.length < 24 + 16) return null;
  try { return xsalsa20poly1305(key, sealed.subarray(0, 24)).decrypt(sealed.subarray(24)); } catch { return null; }
}

// -- frames ---------------------------------------------------------------------------------------------------------

/** What a device says about itself in the first frame (WISP 06 § Versions). */
export interface HandoffHello {
  v: 1;
  /** This session's X25519 public key, base64url. */
  e: string;
  /** The app's version. */
  app: string;
  /** The peer database's schema version (`DB_VERSION`). */
  db: number;
  /** The pinned version of each wallet SDK, by wallet type. */
  pins: Record<string, string>;
  kind: DeviceKind;
  /** Bytes free for the profile on this device, or -1 when the platform does not say. */
  room: number;
  /** On a connection that costs by the byte (mobile data). */
  metered: boolean;
  /** The taker: files over this many bytes stay behind for later; 0 for none. */
  later?: number;
  /** The handoff this session goes on with. */
  id?: string;
}

const isPins = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 16
  && Object.entries(value).every(([type, version]) => /^[a-z0-9-]{1,32}$/.test(type) && isText(version, VERSION_TEXT));

export function handoffHelloFrame(hello: HandoffHello): DeviceFrame {
  return { t: HANDOFF_HELLO, ...hello };
}

export function readHandoffHello(frame: DeviceFrame): HandoffHello | null {
  if (frame.t !== HANDOFF_HELLO || frame.v !== HANDOFF_VERSION) return null;
  if (!isText(frame.e, KEY) || fromBase64Url(frame.e).length !== 32) return null;
  if (!isText(frame.app, VERSION_TEXT) || !isCount(frame.db, 1_000_000) || !isPins(frame.pins)) return null;
  if (typeof frame.room !== "number" || !Number.isSafeInteger(frame.room) || frame.room < -1) return null;
  if (typeof frame.metered !== "boolean") return null;
  if (frame.later !== undefined && !isCount(frame.later)) return null;
  if (frame.id !== undefined && !isText(frame.id, ID)) return null;
  const kind = (DEVICE_KINDS as readonly unknown[]).includes(frame.kind) ? frame.kind as DeviceKind : "web";
  return {
    v: 1, e: frame.e, app: frame.app, db: frame.db, pins: { ...frame.pins }, kind, room: frame.room, metered: frame.metered,
    ...(frame.later !== undefined ? { later: frame.later } : {}), ...(frame.id !== undefined ? { id: frame.id } : {}),
  };
}

/** A new handoff's id: 16 random bytes, base64url. */
export const newHandoffId = (): string => toBase64Url(randomBytes(16));

/** `handoff-request` (B): `turn` is the turn B read as the active device's, `id` the handoff's. */
export const handoffRequestFrame = (turn: number, id: string): DeviceFrame => ({ t: HANDOFF_REQUEST, turn, id });
/** `handoff-offer` (A, a push): `bytes` is about how much would move. */
export const handoffOfferFrame = (turn: number, id: string, bytes: number): DeviceFrame => ({ t: HANDOFF_OFFER, turn, id, bytes });

export function readHandoffTurnFrame(frame: DeviceFrame): { turn: number; id: string; bytes?: number } | null {
  if (frame.t !== HANDOFF_REQUEST && frame.t !== HANDOFF_OFFER) return null;
  if (!isCount(frame.turn, TURN_MAX) || !isText(frame.id, ID)) return null;
  if (frame.t === HANDOFF_OFFER) return isCount(frame.bytes) ? { turn: frame.turn, id: frame.id, bytes: frame.bytes } : null;
  return { turn: frame.turn, id: frame.id };
}

export const handoffBusyFrame = (why: HandoffBusyReason, retry: number): DeviceFrame => ({ t: HANDOFF_BUSY, why, retry });
export function readHandoffBusy(frame: DeviceFrame): { why: HandoffBusyReason; retry: number } | null {
  if (frame.t !== HANDOFF_BUSY || !(HANDOFF_BUSY_REASONS as readonly unknown[]).includes(frame.why) || !isCount(frame.retry, 366 * 86_400)) return null;
  return { why: frame.why as HandoffBusyReason, retry: frame.retry };
}

export const handoffCancelFrame = (why: HandoffCancelReason): DeviceFrame => ({ t: HANDOFF_CANCEL, why });
export function readHandoffCancel(frame: DeviceFrame): HandoffCancelReason | null {
  if (frame.t !== HANDOFF_CANCEL) return null;
  return (HANDOFF_CANCEL_REASONS as readonly unknown[]).includes(frame.why) ? frame.why as HandoffCancelReason : "failed";
}

/** `handoff-pake`: one of the three messages of the password proof. */
export interface HandoffPake { n: 1 | 2 | 3; m?: string; c?: string; wrong?: true }
export const handoffPakeFrame = (pake: HandoffPake): DeviceFrame => ({ t: HANDOFF_PAKE, ...pake });
export function readHandoffPake(frame: DeviceFrame): HandoffPake | null {
  if (frame.t !== HANDOFF_PAKE || (frame.n !== 1 && frame.n !== 2 && frame.n !== 3)) return null;
  if (frame.wrong === true) return frame.n === 3 ? { n: 3, wrong: true } : null;
  if (!isText(frame.m, B64) || !frame.m.length || frame.m.length > 4096) return null;
  if (frame.n === 3 && !isText(frame.c, KEY)) return null;
  return { n: frame.n, m: frame.m, ...(frame.n === 3 ? { c: frame.c as string } : {}) };
}

/** `handoff-have` (B): digests of the files it holds, and parts it holds in part, in frames of `HANDOFF_LIST_PER_FRAME`. */
export function handoffHaveFrames(digests: readonly string[], partial: Record<string, number> = {}): DeviceFrame[] {
  const sorted = [...new Set(digests)].sort();
  const frames: DeviceFrame[] = [];
  for (let at = 0; at < sorted.length || !frames.length; at += HANDOFF_LIST_PER_FRAME) frames.push({ t: HANDOFF_HAVE, d: sorted.slice(at, at + HANDOFF_LIST_PER_FRAME) });
  frames[frames.length - 1].p = partial;
  frames.forEach((frame, i) => { if (i < frames.length - 1) frame.more = true; });
  return frames;
}
export function readHandoffHave(frame: DeviceFrame): { d: string[]; p: Record<string, number>; more: boolean } | null {
  if (frame.t !== HANDOFF_HAVE || !Array.isArray(frame.d) || frame.d.length > HANDOFF_LIST_PER_FRAME || !frame.d.every((d) => isText(d, DIGEST))) return null;
  const p: Record<string, number> = {};
  if (frame.p !== undefined) {
    if (!frame.p || typeof frame.p !== "object" || Array.isArray(frame.p) || Object.keys(frame.p).length > HANDOFF_LIST_PER_FRAME) return null;
    for (const [name, offset] of Object.entries(frame.p)) { if (!isHandoffPartName(name) || !isCount(offset, MAX_PART)) return null; p[name] = offset; }
  }
  return { d: [...frame.d as string[]], p, more: frame.more === true };
}

/**
 * A manifest as one side holds it: the parts to send, the files left for later, and which file ids each digest is,
 * for every file the giver holds (sent now, sent before, or already on the taker), so the taker writes each file under
 * the id its records name.
 */
export interface HandoffManifest { pass: 1 | 2; parts: HandoffPart[]; ids: Record<string, string[]>; later: HandoffPart[] }

/** `handoff-manifest` (A), in as many frames as it takes. */
export function handoffManifestFrames(manifest: HandoffManifest): DeviceFrame[] {
  type Entry = ["parts" | "later", HandoffPart] | ["ids", [string, string[]]];
  const entries: Entry[] = [
    ...sortParts(manifest.parts).map((p): Entry => ["parts", p]),
    ...sortParts(manifest.later).map((p): Entry => ["later", p]),
    ...Object.entries(manifest.ids).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([digest, ids]): Entry => ["ids", [digest, ids]]),
  ];
  const frames: DeviceFrame[] = [];
  for (let at = 0; at < entries.length || !frames.length; at += HANDOFF_LIST_PER_FRAME) {
    const slice = entries.slice(at, at + HANDOFF_LIST_PER_FRAME);
    const pick = (kind: "parts" | "later") => slice.filter((e) => e[0] === kind).map((e) => e[1] as HandoffPart);
    const ids = Object.fromEntries(slice.filter((e) => e[0] === "ids").map((e) => e[1] as [string, string[]]));
    frames.push({ t: HANDOFF_MANIFEST, pass: manifest.pass, parts: pick("parts"), later: pick("later"), ids });
  }
  frames.forEach((frame, i) => { if (i < frames.length - 1) frame.more = true; });
  return frames;
}

export function readHandoffManifest(frame: DeviceFrame): (HandoffManifest & { more: boolean }) | null {
  if (frame.t !== HANDOFF_MANIFEST || (frame.pass !== 1 && frame.pass !== 2)) return null;
  const list = (value: unknown): HandoffPart[] | null => (Array.isArray(value) && value.length <= HANDOFF_LIST_PER_FRAME && value.every(isPart) ? value.map((p) => [p[0], p[1], p[2]] as HandoffPart) : null);
  const parts = list(frame.parts ?? []), later = list(frame.later ?? []);
  if (!parts || !later) return null;
  const ids: Record<string, string[]> = {};
  if (frame.ids !== undefined) {
    if (!frame.ids || typeof frame.ids !== "object" || Array.isArray(frame.ids)) return null;
    for (const [digest, list] of Object.entries(frame.ids)) {
      if (!DIGEST.test(digest) || !Array.isArray(list) || !list.length || list.length > 64 || !list.every((id) => isText(id, FILE_ID))) return null;
      ids[digest] = [...list as string[]];
    }
  }
  return { pass: frame.pass, parts, later, ids, more: frame.more === true };
}

/** `handoff-data`: one sealed piece of part `p` at byte `o` of the part. */
export const handoffDataFrame = (part: string, offset: number, sealed: Uint8Array): DeviceFrame => ({ t: HANDOFF_DATA, p: part, o: offset, d: toBase64Url(sealed) });
export function readHandoffData(frame: DeviceFrame): { part: string; offset: number; sealed: Uint8Array } | null {
  if (frame.t !== HANDOFF_DATA || !isHandoffPartName(frame.p) || !isCount(frame.o, MAX_PART) || !isText(frame.d, B64)) return null;
  const sealed = fromBase64Url(frame.d);
  if (sealed.length < 40 || sealed.length > HANDOFF_PIECE_BYTES + 40) return null;
  return { part: frame.p, offset: frame.o, sealed };
}

/** `handoff-ack`: the taker holds part `p` up to byte `o`, written. */
export const handoffAckFrame = (part: string, offset: number): DeviceFrame => ({ t: HANDOFF_ACK, p: part, o: offset });
export function readHandoffAck(frame: DeviceFrame): { part: string; offset: number } | null {
  if (frame.t !== HANDOFF_ACK || !isHandoffPartName(frame.p) || !isCount(frame.o, MAX_PART)) return null;
  return { part: frame.p, offset: frame.o };
}

/** `handoff-verified` (B): `H`, and B's signature over it (`handoffVerifiedMessage`). */
export async function handoffVerifiedFrame(turnAddress: Uint8Array, turn: number, h: Uint8Array, signer: Signer): Promise<DeviceFrame> {
  return { t: HANDOFF_VERIFIED, h: toBase64Url(h), s: toBase64Url(await signer.sign(handoffVerifiedMessage(turnAddress, turn, h))) };
}
/** `H` of a `handoff-verified` that B's key signed for this turn address and turn, or null. */
export function readHandoffVerified(frame: DeviceFrame, turnAddress: Uint8Array, turn: number, takerKey: Uint8Array): Uint8Array | null {
  if (frame.t !== HANDOFF_VERIFIED || !isText(frame.h, DIGEST) || !isText(frame.s, SIGNATURE)) return null;
  const h = fromBase64Url(frame.h);
  try { return verify(fromBase64Url(frame.s), handoffVerifiedMessage(turnAddress, turn, h), takerKey) ? h : null; } catch { return null; }
}

/** `handoff-release` (A): the release of the turn record, as A signed it into its own state. */
export interface HandoffReleaseFrame { turn: number; to: string; h: string; s: string }
export const handoffReleaseFrame = (release: HandoffReleaseFrame): DeviceFrame => ({ t: HANDOFF_RELEASE, ...release });
export function readHandoffRelease(frame: DeviceFrame): HandoffReleaseFrame | null {
  if (frame.t !== HANDOFF_RELEASE || !isCount(frame.turn, TURN_MAX) || !isText(frame.to, KEY) || !isText(frame.h, DIGEST) || !isText(frame.s, SIGNATURE)) return null;
  return { turn: frame.turn, to: frame.to, h: frame.h, s: frame.s };
}

export const handoffDoneFrame = (sequence: number): DeviceFrame => ({ t: HANDOFF_DONE, seq: sequence });
export function readHandoffDone(frame: DeviceFrame): number | null {
  return frame.t === HANDOFF_DONE && isCount(frame.seq) ? frame.seq : null;
}

export const handoffFileRequestFrame = (sha256B64: string): DeviceFrame => ({ t: HANDOFF_FILE_REQUEST, sha256: sha256B64 });
export const handoffFileMissingFrame = (sha256B64: string): DeviceFrame => ({ t: HANDOFF_FILE_MISSING, sha256: sha256B64 });
export function readHandoffFileFrame(frame: DeviceFrame): { missing: boolean; sha256: string } | null {
  if ((frame.t !== HANDOFF_FILE_REQUEST && frame.t !== HANDOFF_FILE_MISSING) || !isText(frame.sha256, DIGEST)) return null;
  return { missing: frame.t === HANDOFF_FILE_MISSING, sha256: frame.sha256 };
}

// -- versions -------------------------------------------------------------------------------------------------------

/**
 * Whether two devices can hand over (WISP 06 § Versions), seen from the taker: a taker whose database is older than
 * the giver's cannot read what it would get (`older`: "Update Ghostly on this device first."). A newer taker migrates
 * on arrival, and the giver, older now, must update before it takes the profile back (`newerTaker`). A wallet whose
 * SDK pin differs stays home (`stayHome`, by wallet type).
 */
export function handoffVersions(giver: Pick<HandoffHello, "db" | "pins" | "app">, taker: Pick<HandoffHello, "db" | "pins" | "app">): { older: boolean; newerTaker: boolean; stayHome: string[] } {
  const types = new Set([...Object.keys(giver.pins), ...Object.keys(taker.pins)]);
  const stayHome = [...types].filter((type) => giver.pins[type] !== undefined && giver.pins[type] !== taker.pins[type]).sort();
  return { older: taker.db < giver.db, newerTaker: taker.db > giver.db, stayHome };
}

// -- attempts -------------------------------------------------------------------------------------------------------

/** The WISP's limits on wrong passwords, per taking device (§ Authorizing a handoff). */
export const HANDOFF_ATTEMPTS = { perHour: 5, hourMs: 60 * 60_000, total: 15 } as const;

/** What the giver keeps of one taking device's attempts. */
export interface HandoffAttempts {
  /** When each failure of the last hour happened (ms). */
  recent: number[];
  /** Failures since the last success. */
  total: number;
  /** Locked out until then (ms). */
  until?: number;
}

export const NO_ATTEMPTS: HandoffAttempts = { recent: [], total: 0 };

/** Whether a device may try now: `refused` after 15 failures with no success, until the person lets it try again. */
export function handoffAttemptAllowed(attempts: HandoffAttempts | undefined, now: number): "ok" | "locked-out" | "refused" {
  if (!attempts) return "ok";
  if (attempts.total >= HANDOFF_ATTEMPTS.total) return "refused";
  if (attempts.until !== undefined && now < attempts.until) return "locked-out";
  return "ok";
}

/**
 * One more failure. The giver counts an attempt as failed when it answers the first message, before it learns the
 * outcome, and takes it back on success: a taker that stops after the second message has used a try.
 */
export function handoffAttemptFailed(attempts: HandoffAttempts | undefined, now: number): HandoffAttempts {
  const recent = [...(attempts?.recent ?? []).filter((at) => now - at < HANDOFF_ATTEMPTS.hourMs), now];
  const total = (attempts?.total ?? 0) + 1;
  if (recent.length >= HANDOFF_ATTEMPTS.perHour) return { recent: [], total, until: now + HANDOFF_ATTEMPTS.hourMs };
  return { recent, total, ...(attempts?.until !== undefined && now < attempts.until ? { until: attempts.until } : {}) };
}

/** A proof that held: the count starts again. */
export const handoffAttemptSucceeded = (): HandoffAttempts => ({ recent: [], total: 0 });

/** Seconds until a locked-out device may try again (for `handoff-busy`). */
export const handoffRetryAfter = (attempts: HandoffAttempts | undefined, now: number): number =>
  attempts?.until !== undefined && attempts.until > now ? Math.ceil((attempts.until - now) / 1000) : 0;

/** Two digests compared. */
export const sameDigest = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && bytesEqual(a, b);
