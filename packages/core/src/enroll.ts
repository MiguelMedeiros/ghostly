import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { verify } from "./identity";
import type { DeviceFrame } from "./deviceLink";
import type { Signer } from "./signer";
import { TURN_MAX, TURN_REV_LIMIT, TURN_SLOTS, turnName } from "./turnRecord";

/*
 * `enroll/1` (WISP 06 § Adding a device): the frames of the one-time session a device code opens, and what both sides
 * sign and compute. The session is an ordinary paired session whose participation keys are the two device signing
 * keys; the joiner (B) pinned the inviter's (A) from the code, and A takes the first joiner's key for this one session.
 *
 * 1. `B → A` `enroll-hello`: B's key, name, kind and app version, signed by B over the tuple below.
 * 2. `A → B` `enroll-proof`: the same tuple, signed by A. B checks it against the key in the code.
 * 3. Both compute six digits from the session's transcript hash and the two keys. B shows them only after step 2.
 * 4. The person confirms on A that both screens show the same digits.
 * 5. `A → B` `enroll-grant`: `D`, the device set with B's slot, the turn and `rev` A will publish. B stores it as
 *    `standby` and answers `enroll-done`.
 * 6. A publishes the turn record with B listed. Only then is B a device.
 *
 * `enroll-cancel` is this build's own: either side ends the session and says why (digits that did not match, a code
 * already used, an error), so the other screen can say so at once rather than waiting for a timeout.
 *
 * The WISP leaves the encoding of the signed tuple open. It is the house form (`deviceLink.ts`): the UTF-8 bytes of
 * the JSON array `["ghostly-enroll", <transcript hash, lower-case hex>, <A's key, base64url>, <B's key, base64url>]`.
 * The vectors in `packages/core/test/vectors/enroll.json` pin it.
 */

export const ENROLL_HELLO = "enroll-hello";
export const ENROLL_PROOF = "enroll-proof";
export const ENROLL_GRANT = "enroll-grant";
export const ENROLL_DONE = "enroll-done";
export const ENROLL_CANCEL = "enroll-cancel";

/** What kind of client a device is (WISP 06 § Terms). Anything else a hello says is read as `web`. */
export const DEVICE_KINDS = ["web", "desktop", "extension"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Why a side ended the session. */
export const ENROLL_CANCEL_REASONS = ["digits", "used", "expired", "cancelled", "full", "failed"] as const;
export type EnrollCancelReason = (typeof ENROLL_CANCEL_REASONS)[number];

const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const HASH = /^[0-9a-f]{64}$/;

function checkKey(key: Uint8Array, who: string): void {
  if (key.length !== 32) throw new Error(`${who}'s device signing key is 32 bytes`);
}

/** The bytes both devices sign: the session, then A's key, then B's. */
export function enrollMessage(transcriptHash: string, inviterKey: Uint8Array, joinerKey: Uint8Array): Uint8Array {
  if (!HASH.test(transcriptHash)) throw new Error("A transcript hash is 64 lower-case hex digits");
  checkKey(inviterKey, "The inviter"); checkKey(joinerKey, "The joiner");
  return utf8Encode(JSON.stringify(["ghostly-enroll", transcriptHash, toBase64Url(inviterKey), toBase64Url(joinerKey)]));
}

/**
 * The six digits both screens show: the first 20 bits of `SHA-256("ghostly-enroll-digits" || transcriptHash ||
 * A's key || B's key)`, as a decimal number modulo 1,000,000, with leading zeros. The transcript hash goes in as its
 * 32 bytes.
 */
export function enrollDigits(transcriptHash: string, inviterKey: Uint8Array, joinerKey: Uint8Array): string {
  if (!HASH.test(transcriptHash)) throw new Error("A transcript hash is 64 lower-case hex digits");
  checkKey(inviterKey, "The inviter"); checkKey(joinerKey, "The joiner");
  const hash = Uint8Array.from(transcriptHash.match(/../g)!, (pair) => parseInt(pair, 16));
  const h = sha256(concatBytes(utf8Encode("ghostly-enroll-digits"), hash, inviterKey, joinerKey));
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  return String(bits % 1_000_000).padStart(6, "0");
}

/** "482913" as people read it: "482 913". */
export const formatEnrollDigits = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** What a hello says of the device that joins. */
export interface EnrollHello {
  key: Uint8Array;
  /** As the device set holds it: at most 16 bytes of UTF-8. */
  name: string;
  kind: DeviceKind;
  app: string;
}

/** `enroll-hello`, signed by the joiner over the tuple. */
export async function enrollHelloFrame(transcriptHash: string, inviterKey: Uint8Array, joiner: Signer, about: { name: string; kind: DeviceKind; app: string }): Promise<DeviceFrame> {
  const signature = await joiner.sign(enrollMessage(transcriptHash, inviterKey, joiner.publicKey));
  return { t: ENROLL_HELLO, k: toBase64Url(joiner.publicKey), name: turnName(about.name), kind: about.kind, app: about.app.slice(0, 32), s: toBase64Url(signature) };
}

/**
 * A hello, checked: its key must be the one the session authenticated (`sessionKey`), and its signature must be that
 * key's over this session's tuple. Null for anything else.
 */
export function readEnrollHello(frame: DeviceFrame, transcriptHash: string, inviterKey: Uint8Array, sessionKey: Uint8Array): EnrollHello | null {
  if (frame.t !== ENROLL_HELLO || typeof frame.k !== "string" || !KEY.test(frame.k) || typeof frame.s !== "string" || !SIGNATURE.test(frame.s)) return null;
  if (typeof frame.name !== "string" || frame.name.length > 64 || typeof frame.app !== "string" || frame.app.length > 32) return null;
  const key = fromBase64Url(frame.k);
  if (key.length !== 32 || toBase64Url(key) !== toBase64Url(sessionKey)) return null;
  if (!verify(fromBase64Url(frame.s), enrollMessage(transcriptHash, inviterKey, key), key)) return null;
  const kind = (DEVICE_KINDS as readonly unknown[]).includes(frame.kind) ? frame.kind as DeviceKind : "web";
  return { key, name: turnName(frame.name), kind, app: frame.app };
}

/** `enroll-proof`: the inviter's signature over the same tuple. */
export async function enrollProofFrame(transcriptHash: string, inviter: Signer, joinerKey: Uint8Array): Promise<DeviceFrame> {
  return { t: ENROLL_PROOF, s: toBase64Url(await inviter.sign(enrollMessage(transcriptHash, inviter.publicKey, joinerKey))) };
}

/** Whether a proof is the inviter's: checked against the key in the code, never against what the session says. */
export function verifyEnrollProof(frame: DeviceFrame, transcriptHash: string, inviterKey: Uint8Array, joinerKey: Uint8Array): boolean {
  if (frame.t !== ENROLL_PROOF || typeof frame.s !== "string" || !SIGNATURE.test(frame.s)) return false;
  try { return verify(fromBase64Url(frame.s), enrollMessage(transcriptHash, inviterKey, joinerKey), inviterKey); } catch { return false; }
}

/** One slot of a granted device set: the key and its name, or null where nobody holds the slot. */
export type EnrollSlot = { key: Uint8Array; name: string } | null;

/** What `enroll-grant` gives the new device. */
export interface EnrollGrant {
  /** The device-set secret, 32 bytes. */
  d: Uint8Array;
  /** By slot, so a slot keeps its index: four entries at most, null where nobody holds it. */
  set: EnrollSlot[];
  turn: number;
  rev: number;
}

/**
 * `enroll-grant`. The WISP writes the set as `[[key, name], ...]`; slots keep their index (after a removal the slots
 * held need not be the first), so an unheld slot is `null` in its place, and trailing unheld slots are left out.
 */
export function enrollGrantFrame(grant: EnrollGrant): DeviceFrame {
  if (grant.d.length !== 32) throw new Error("The device-set secret is 32 bytes");
  if (grant.set.length > TURN_SLOTS) throw new Error("A device set holds four devices at most");
  let set = grant.set.map((slot) => (slot ? [toBase64Url(slot.key), turnName(slot.name)] : null));
  while (set.length && set[set.length - 1] === null) set = set.slice(0, -1);
  return { t: ENROLL_GRANT, d: toBase64Url(grant.d), set, turn: grant.turn, rev: grant.rev };
}

/**
 * A grant, checked for the joiner with `joinerKey`: a 32-byte `D`, a set of at most four slots that lists the joiner
 * once and the inviter once, and a turn and `rev` an ordinary record can have. Null for anything else.
 */
export function readEnrollGrant(frame: DeviceFrame, inviterKey: Uint8Array, joinerKey: Uint8Array): (EnrollGrant & { ownSlot: number; inviterSlot: number }) | null {
  if (frame.t !== ENROLL_GRANT || typeof frame.d !== "string" || !KEY.test(frame.d) || !Array.isArray(frame.set) || frame.set.length > TURN_SLOTS) return null;
  if (!Number.isInteger(frame.turn) || (frame.turn as number) < 0 || (frame.turn as number) > TURN_MAX) return null;
  if (!Number.isInteger(frame.rev) || (frame.rev as number) < 0 || (frame.rev as number) >= TURN_REV_LIMIT) return null;
  const set: EnrollSlot[] = [];
  for (const slot of frame.set as unknown[]) {
    if (slot === null) { set.push(null); continue; }
    if (!Array.isArray(slot) || slot.length !== 2 || typeof slot[0] !== "string" || !KEY.test(slot[0]) || typeof slot[1] !== "string" || slot[1].length > 64) return null;
    set.push({ key: fromBase64Url(slot[0]), name: turnName(slot[1]) });
  }
  const at = (key: Uint8Array) => set.reduce<number[]>((found, slot, index) => (slot && toBase64Url(slot.key) === toBase64Url(key) ? [...found, index] : found), []);
  const own = at(joinerKey), inviter = at(inviterKey);
  if (own.length !== 1 || inviter.length !== 1) return null;
  const keys = set.filter((slot): slot is NonNullable<EnrollSlot> => !!slot).map((slot) => toBase64Url(slot.key));
  if (new Set(keys).size !== keys.length) return null;
  return { d: fromBase64Url(frame.d), set, turn: frame.turn as number, rev: frame.rev as number, ownSlot: own[0], inviterSlot: inviter[0] };
}

export const enrollDoneFrame = (): DeviceFrame => ({ t: ENROLL_DONE });
export const enrollCancelFrame = (why: EnrollCancelReason): DeviceFrame => ({ t: ENROLL_CANCEL, why });

/** The reason a cancel gives, or null when the frame is no cancel. An unknown reason is `failed`. */
export function enrollCancelReason(frame: DeviceFrame): EnrollCancelReason | null {
  if (frame.t !== ENROLL_CANCEL) return null;
  return (ENROLL_CANCEL_REASONS as readonly unknown[]).includes(frame.why) ? frame.why as EnrollCancelReason : "failed";
}
