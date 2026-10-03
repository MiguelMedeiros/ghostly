import { fromBase64Url, readSetUpdate, readTurnPacket, toBase64Url, turnKeys, verifySetUpdate, type DeviceFrame, type TurnKeys, type TurnRecord } from "@ghostly/core";
import { MAX_DEVICES, MAX_EARLIER_SETS, type DevicePatch, type DeviceRecord, type DeviceSlot, type SetNotice } from "./state";

/*
 * Receiving a new device-set secret (WISP 06 § Removing a device, "Who a `moving` device believes"): the rule a device
 * that stays follows when a `set-update` reaches it over its old device link. A pure function of the device record and
 * the frame; `links.ts` carries the answer out (the durable write first, then `set-ack`).
 *
 * A `set-update` is accepted only when it is signed by the device signing key that this device's stored turn record
 * (the last one it accepted before the tombstone) names active, and that key is still listed in the tombstone the
 * frame carries. Without this check a removed device, which still holds the old `D` and a valid old link, could write a
 * tombstone of its own and hand this device a secret of its own. So:
 *
 * - signed by another key (the removed device, any holder of the old `D`), or by the stored active device when the
 *   tombstone no longer lists it: refused. A `moving` device then shows "Your devices changed while this one was off.
 *   Add this device again" and is enrolled anew; it still takes a valid `set-update` that comes later;
 * - a valid tombstone that no longer lists this device: it is `removed`, whoever wrote it, as a tombstone read from the
 *   network says;
 * - a `moving` device kept the tombstone it read from the network: the device it believes must be listed there too, not
 *   only in the tombstone the frame carries, which any holder of the old `D` (the removed device included) can write;
 * - the device it believes is its stored active device, or the one a record the frame carries (`rec`, the remover's
 *   last record at the old address) shows took the turn from it by a release that device signed. A tombstone hides
 *   every record, so a device that stays and did not look while the turn was handed over can read that record nowhere
 *   else. A forced takeover carries no release, and is not believed this way: such a device was off across a takeover;
 * - accepted: the device is `standby` under the new `D` with the set the frame names, holds no turn packet of the new
 *   set until it reads the remover's record there, and shows the new device list once (`setNotice`). It keeps the
 *   frame beside the old `D`, to forward unchanged to a device that stays and was off (other holders of `D'` sign
 *   nothing of their own).
 */

/** Why a `set-update` is not accepted. */
export type SetUpdateRefusal =
  /** Not a well-formed frame. */
  | "malformed"
  /** This device is in no state that takes one (active, releasing, taking, removed), or holds no device set. */
  | "state"
  /** The tombstone it carries does not close this device's address. */
  | "tombstone"
  /** Its signature does not verify. */
  | "signature"
  /** Signed by a key other than the one this device's stored record names active. */
  | "signer"
  /** The stored active device is not listed in the tombstone (it was removed, or this device was off across a takeover). */
  | "unlisted"
  /** The set it names is not the devices the tombstone keeps, or does not keep this device in its slot. */
  | "set"
  /** The tombstone does not list this device: it was removed. */
  | "removed";

export type SetUpdateCheck =
  /** Write `patch` (after `moving` first, for a device that is `superseded`), then answer `set-ack`. */
  | { kind: "accept"; from: DeviceRecord["state"]; patch: DevicePatch }
  /** This device already holds that `D'`: it just answers. */
  | { kind: "known" }
  /** Nothing is written, unless `removed` (then the device is `removed`) or `reenroll` (a `moving` device shows "Add this device again"). */
  | { kind: "refuse"; why: SetUpdateRefusal; reenroll: boolean };

const ACCEPTING = new Set<DeviceRecord["state"]>(["standby", "moving", "superseded"]);

/**
 * Whether the stored active device of `record` may hand this device a new set, judged from the tombstone alone: false
 * when the tombstone does not list it (it was removed, or this device was off across a takeover), or when it is this
 * device itself (something else closed its address). Then no `set-update` can ever be accepted here.
 */
export function storedActiveListed(record: DeviceRecord, tombstone: TurnRecord): boolean {
  const active = record.activeSlot === undefined ? undefined : record.deviceSet[record.activeSlot]?.key;
  if (!active || record.activeSlot === record.ownSlot) return false;
  return listedIn(tombstone, active);
}

const listedIn = (record: TurnRecord, key: string): boolean => record.slots.some((slot) => !!slot && toBase64Url(slot.key) === key);

/**
 * The device this device believes for a `set-update` signed by `by`: its stored active device; or `by`, when `rec` is a
 * valid ordinary record at the old address, newer than the one stored here, written by `by` as the active device, with
 * a release that the stored active device signed (WISP 06 § Record: a release names its taker). Null when it has none.
 */
function believed(record: DeviceRecord, oldKeys: TurnKeys, by: string, rec: Uint8Array | undefined): string | null {
  const stored = record.activeSlot === undefined || record.activeSlot === record.ownSlot ? undefined : record.deviceSet[record.activeSlot]?.key;
  if (!stored) return null;
  if (by === stored || !rec) return stored;
  const carried = readTurnPacket(oldKeys, rec);
  if (carried.kind !== "valid" || carried.record.tombstone) return stored;
  const r = carried.record;
  const author = r.slots[r.author], release = r.release;
  if (!author || toBase64Url(author.key) !== by || !release || release.from === release.to) return stored;
  // `readTurnPacket` checked the release's signature against the key in slot `from`: that key must be the one believed.
  if (toBase64Url(r.slots[release.from]!.key) !== stored) return stored;
  const held = record.turnPacket ? readTurnPacket(oldKeys, fromBase64Url(record.turnPacket)) : null;
  if (held?.kind === "valid" && carried.sequence <= held.sequence) return stored;
  // With no packet stored (a device that never read one, or whose packet is not a record here), the stored turn is the
  // floor: a real release from an earlier turn, replayed, says nothing about who holds the turn now.
  if (held?.kind !== "valid" && r.turn <= record.turn) return stored;
  return by;
}

/** The rule above, for `frame` reaching a device whose record is `record`. `now`: when, for the notice. */
export function checkSetUpdate(record: DeviceRecord | null, frame: DeviceFrame, now: number): SetUpdateCheck {
  const refuse = (why: SetUpdateRefusal, reenroll = false): SetUpdateCheck => ({ kind: "refuse", why, reenroll: reenroll && record?.state === "moving" });
  const update = readSetUpdate(frame);
  if (!update) return refuse("malformed");
  if (!record?.d || record.ownSlot === undefined || !record.deviceSet[record.ownSlot]) return refuse("state");
  const own = record.deviceSet[record.ownSlot]!.key;
  if (toBase64Url(update.d) === record.d) return { kind: "known" };
  if (!ACCEPTING.has(record.state)) return refuse("state");

  const oldKeys = turnKeys(fromBase64Url(record.d));
  const read = readTurnPacket(oldKeys, update.tomb);
  // A tombstone for another address (a frame of an earlier set, forwarded late) says nothing about this one.
  if (read.kind !== "valid" || !read.record.tombstone) return refuse("tombstone");
  const tomb = read.record;
  if (!tomb.slots.some((slot) => !!slot && toBase64Url(slot.key) === own)) return refuse("removed");
  // A signature that does not verify says nothing about who is believed: refused, and no more than that.
  if (!verifySetUpdate(update, oldKeys.address)) return refuse("signature");
  const by = toBase64Url(update.by);
  const active = believed(record, oldKeys, by, update.rec);
  if (!active || by !== active) return refuse("signer", true);
  if (!listedIn(tomb, active)) return refuse("unlisted", true);
  // The tombstone this device read from the network decides too: the frame's own may be one the removed device wrote.
  if (record.tombstone) {
    const kept = readTurnPacket(oldKeys, fromBase64Url(record.tombstone));
    if (kept.kind !== "valid" || !kept.record.tombstone || !listedIn(kept.record, active)) return refuse("unlisted", true);
  }

  // The set keeps each device in the slot it had, and only devices the tombstone keeps. This device and the remover are in it.
  const set: (DeviceSlot | null)[] = Array.from({ length: MAX_DEVICES }, (_, i) => { const slot = update.set[i]; return slot ? { key: toBase64Url(slot.key), name: slot.name } : null; });
  const kept = set.every((slot, i) => !slot || (!!tomb.slots[i] && toBase64Url(tomb.slots[i]!.key) === slot.key));
  const bySlot = set.findIndex((slot) => slot?.key === by);
  if (!kept || set[record.ownSlot]?.key !== own || bySlot < 0) return refuse("set");

  const notice: SetNotice = { names: set.flatMap((slot) => (slot ? [slot.name] : [])), at: now };
  // Kept to forward, unchanged, to the other devices that stay and may have been off; never to the remover or itself.
  const pending = set.flatMap((slot) => (slot && slot.key !== own && slot.key !== by ? [slot.key] : []));
  const earlier = { d: record.d, tombstone: toBase64Url(update.tomb), setUpdate: JSON.stringify(frame), pending };
  return {
    kind: "accept", from: record.state,
    patch: {
      d: toBase64Url(update.d), deviceSet: set, turn: update.turn, rev: update.rev, activeSlot: bySlot,
      // The new set's record is the remover's, read at the new address; the old packet is not a record there. The
      // mark belongs to the old address.
      turnPacket: undefined, seenSequence: 0, tombstone: undefined, reenroll: undefined, settle: undefined, setNotice: notice,
      earlierSets: [...record.earlierSets.filter((e) => e.d !== record.d), earlier].slice(-MAX_EARLIER_SETS),
    },
  };
}
