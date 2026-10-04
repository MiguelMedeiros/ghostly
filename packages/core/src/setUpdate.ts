import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import type { DeviceFrame } from "./deviceLink";
import type { EnrollSlot } from "./enroll";
import { verify } from "./identity";
import type { Signer } from "./signer";
import { signTurnPacket, TOMBSTONE_TURN, TURN_MAX, TURN_NO_ACTIVE, TURN_REV_LIMIT, TURN_SLOTS, turnName, type TurnKeys, type TurnSigner, type TurnSlot } from "./turnRecord";

/*
 * Removing a device (WISP 06 § Removing a device): the tombstone that closes the old turn address, and the one signed
 * `set-update` frame that hands the new device-set secret `D'` to each device that stays, over its old device link,
 * under `devices/1`.
 *
 * `{"t":"set-update","d":"<D'>","set":[[key, name], ...],"turn":N,"rev":R,"tomb":"<the tombstone packet>","by":"<the remover's key>","s":"<signature>"}`
 * `{"t":"set-ack"}`
 *
 * `s` is the remover's signature over `["ghostly-set-update", old turn address, d, set, turn, rev, SHA-256(tomb)]`.
 * The WISP leaves the encoding of the tuple open. It is the house form (`enroll.ts`, `deviceLink.ts`): the UTF-8 bytes
 * of that JSON array, every byte string in it base64url, and `set` exactly as the frame carries it. `set` is written as
 * `enroll-grant` writes it: by slot, a slot nobody holds is `null` in its place, trailing unheld slots left out (after
 * a removal the slots held need not be the first). The vectors in `packages/core/test/vectors/set-update.json` pin it.
 *
 * `rec`, this build's own field beside the WISP's: the remover's last ordinary record at the old address, as a packet.
 * A tombstone outranks every record there, so a device that stays and never read that record (it was handed over or
 * taken while the device did not look) cannot read it any more; the record is signed by its own author and carries its
 * release, so the receiver checks it alone (`devices/setUpdate.ts`). It is outside the signed tuple: it proves itself.
 *
 * Nothing here decides who is believed: that is the receiver's rule (`packages/browser/src/devices/setUpdate.ts`).
 */

export const SET_UPDATE = "set-update";
export const SET_ACK = "set-ack";

const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** A tombstone packet is a relay payload of 706 bytes (WISP 06 § Record); a little room above it, nothing more. */
const TOMB = /^[A-Za-z0-9_-]{100,1400}$/;

/** What a `set-update` says. */
export interface SetUpdate {
  /** The new device-set secret, 32 bytes. */
  d: Uint8Array;
  /** By slot: the devices that stay, each in the slot it had. */
  set: EnrollSlot[];
  /** The turn and `rev` of the first record the remover puts at the new address. */
  turn: number;
  rev: number;
  /** The tombstone packet put at the old address, as a relay payload. */
  tomb: Uint8Array;
  /** The remover's device signing key. */
  by: Uint8Array;
  /** The remover's last ordinary record at the old address, as a packet (`rec`). Optional. */
  rec?: Uint8Array;
}

/** The set as the frame and the signature carry it: by slot, `null` where nobody holds one, trailing ones left out. */
export function encodeSetSlots(set: readonly EnrollSlot[]): ([string, string] | null)[] {
  if (set.length > TURN_SLOTS) throw new Error("A device set holds four devices at most");
  let out = set.map((slot): [string, string] | null => (slot ? [toBase64Url(slot.key), turnName(slot.name)] : null));
  while (out.length && out[out.length - 1] === null) out = out.slice(0, -1);
  return out;
}

/** The bytes the remover signs: the old turn address, then the frame's fields, the tombstone by its digest. */
export function setUpdateMessage(oldAddress: Uint8Array, update: Omit<SetUpdate, "by" | "rec">): Uint8Array {
  if (oldAddress.length !== 32) throw new Error("A turn address is 32 bytes");
  if (update.d.length !== 32) throw new Error("The device-set secret is 32 bytes");
  return utf8Encode(JSON.stringify(["ghostly-set-update", toBase64Url(oldAddress), toBase64Url(update.d), encodeSetSlots(update.set), update.turn, update.rev, toBase64Url(sha256(update.tomb))]));
}

/** The signed frame. `oldAddress`: the turn address the tombstone closes. */
export async function setUpdateFrame(oldAddress: Uint8Array, update: Omit<SetUpdate, "by">, signer: Signer): Promise<DeviceFrame> {
  if (update.rec && !TOMB.test(toBase64Url(update.rec))) throw new Error("A record is a turn packet");
  if (!Number.isInteger(update.turn) || update.turn < 0 || update.turn > TURN_MAX) throw new Error("A turn is at most 2^32 - 2");
  if (!Number.isInteger(update.rev) || update.rev < 0 || update.rev >= TURN_REV_LIMIT) throw new Error("A rev is under 2^18");
  const signature = await signer.sign(setUpdateMessage(oldAddress, update));
  return {
    t: SET_UPDATE, d: toBase64Url(update.d), set: encodeSetSlots(update.set), turn: update.turn, rev: update.rev, tomb: toBase64Url(update.tomb),
    by: toBase64Url(signer.publicKey), s: toBase64Url(signature), ...(update.rec ? { rec: toBase64Url(update.rec) } : {}),
  };
}

/**
 * A `set-update` as it reads, with its signature, or null when it is not well formed. Its signature is not checked
 * here: that needs the old turn address (`verifySetUpdate`).
 */
export function readSetUpdate(frame: DeviceFrame): (SetUpdate & { signature: Uint8Array }) | null {
  if (frame.t !== SET_UPDATE || typeof frame.d !== "string" || !KEY.test(frame.d) || typeof frame.by !== "string" || !KEY.test(frame.by)) return null;
  if (typeof frame.s !== "string" || !SIGNATURE.test(frame.s) || typeof frame.tomb !== "string" || !TOMB.test(frame.tomb)) return null;
  if (!Array.isArray(frame.set) || frame.set.length > TURN_SLOTS) return null;
  if (frame.rec !== undefined && (typeof frame.rec !== "string" || !TOMB.test(frame.rec))) return null;
  if (!Number.isInteger(frame.turn) || (frame.turn as number) < 0 || (frame.turn as number) > TURN_MAX) return null;
  if (!Number.isInteger(frame.rev) || (frame.rev as number) < 0 || (frame.rev as number) >= TURN_REV_LIMIT) return null;
  const set: EnrollSlot[] = [];
  for (const slot of frame.set as unknown[]) {
    if (slot === null) { set.push(null); continue; }
    if (!Array.isArray(slot) || slot.length !== 2 || typeof slot[0] !== "string" || !KEY.test(slot[0]) || typeof slot[1] !== "string" || slot[1].length > 64) return null;
    // A name the signature covers is read as written: one cut here would no longer be what was signed.
    if (turnName(slot[1]) !== slot[1]) return null;
    set.push({ key: fromBase64Url(slot[0]), name: slot[1] });
  }
  const keys = set.flatMap((slot) => (slot ? [toBase64Url(slot.key)] : []));
  if (!keys.length || new Set(keys).size !== keys.length) return null;
  return {
    d: fromBase64Url(frame.d), set, turn: frame.turn as number, rev: frame.rev as number, tomb: fromBase64Url(frame.tomb), by: fromBase64Url(frame.by), signature: fromBase64Url(frame.s),
    ...(typeof frame.rec === "string" ? { rec: fromBase64Url(frame.rec) } : {}),
  };
}

/** Whether `by` signed this update for the turn address `oldAddress`. */
export function verifySetUpdate(update: SetUpdate & { signature: Uint8Array }, oldAddress: Uint8Array): boolean {
  try { return verify(update.signature, setUpdateMessage(oldAddress, update), update.by); } catch { return false; }
}

export const setAckFrame = (): DeviceFrame => ({ t: SET_ACK });

/**
 * The tombstone of a turn address (WISP 06 § Removing a device): the turn record with turn 2^32 - 1 and no active
 * device, its slots the devices that stay (zero for the one removed), signed by the remover from its own slot, `rev` 0,
 * no release, a random `instance`. Every tombstone has the sequence 2^52 - 1. Its packet, to be stored before it is put.
 */
export async function signTombstone(keys: TurnKeys, author: number, slots: readonly (TurnSlot | null)[], signer: TurnSigner, fixed: { instance?: Uint8Array; nonce?: Uint8Array } = {}): Promise<Uint8Array> {
  const padded = Array.from({ length: TURN_SLOTS }, (_, i) => slots[i] ?? null);
  return signTurnPacket(keys, { turn: TOMBSTONE_TURN, rev: 0, author, active: TURN_NO_ACTIVE, slots: padded, instance: fixed.instance ?? randomBytes(8) }, signer, fixed.nonce);
}
