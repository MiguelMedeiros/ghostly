import {
  bytesEqual, classifyTurnRead, fromBase64Url, newDeviceSetSecret, randomBytes, setUpdateFrame, signTombstone, signTurnPacket, toBase64Url, turnKeys,
  type DeviceFrame, type Signer, type TurnKeys, type TurnNetwork, type TurnSourcePut,
} from "@ghostly/core";
import { MAX_DEVICES, MAX_EARLIER_SETS, type DevicePatch, type DeviceRecord, type DeviceSlot, type EarlierDeviceSet } from "./state";

/*
 * Removing a device, and "New device secret" (WISP 06 § Removing a device): only the active device does it. In order:
 *
 * 1. a new random device-set secret `D'` (so a new turn address and new device links), the tombstone for the old
 *    address (the devices that stay, the removed one's slot zero), the first record at the new address, and one signed
 *    `set-update` frame;
 * 2. all of it is stored in one durable write before anything leaves the device: `D'`, the old `D`, the tombstone, the
 *    frame and the staying devices that have not acknowledged it. A crash before this write means nothing happened;
 *    after it, every later step runs again from the record alone, at the next start or the next call;
 * 3. the record at the new address is put (nobody else holds `D'`, so it has no rival and needs no settle wait);
 * 4. the tombstone is put at the old address, and again every hour while the profile exists;
 * 5. the frame goes to each staying device over its old link, at every session, until it answers `set-ack` (or shows
 *    up on a link under `D'`, which only a holder of `D'` with its own signing key can open). That delivery is the
 *    device links' (`links.ts`), from the pending lists this write leaves.
 *
 * "New device secret" is the same with nobody removed: every device listed stays, and a device that was granted `D`
 * and never finished its enrollment (`rotate.ts`) is not listed, so it gets nothing and loses `D`. The grants are
 * dropped in the same write as `D'`.
 *
 * A device that was off across two moves still gets the newest set: the frames of earlier sets still waiting for it are
 * signed again with the newest `D'`, over the same old tombstone.
 */

/** Why a removal or a new secret was refused before anything was written. Its message starts with `remove-<reason>:`. */
export class SetMoveRefusal extends Error {
  constructor(readonly reason: "state" | "device" | "self" | "key", message: string) {
    super(`remove-${reason}: ${message}`);
    this.name = "SetMoveRefusal";
  }
}

export interface SetMovePorts {
  read(): Promise<DeviceRecord | null>;
  amend(patch: DevicePatch): Promise<DeviceRecord>;
  /** This device's signing key. */
  signer: Signer;
  /** The turn record's sources: the new record and the tombstones are put there. Null: offline, the steps wait for the next start. */
  network: TurnNetwork | null;
  /** Brings the device links in line with the record: the removed device's link closes, the old links to staying devices deliver. */
  refresh?(): Promise<void>;
  /** Tests: throws at a named step, as a crash there would stop the run. */
  crash?(point: SetMoveStep): void;
  now?: () => number;
  random?: (length: number) => Uint8Array;
}

/** The points a crash may hit, in order. */
export type SetMoveStep = "planned" | "stored" | "turn-put" | "tombstone-put";

/** What one move did. */
export interface SetMoveReport {
  record: DeviceRecord;
  /** The device removed, by its slot; absent for a new secret. */
  removed?: DeviceSlot;
  turnPut: TurnSourcePut[];
  tombstones: TombstonePut[];
}

/** The first `rev` at a new address. */
const FIRST_REV = 0;

/**
 * Steps 1 and 2's content: the write that moves the set. `remove`: the signing key (base64url) of the device that goes;
 * absent for "New device secret". Throws `SetMoveRefusal` when this device may not move the set.
 */
export async function planSetMove(record: DeviceRecord | null, signer: Signer, options: { remove?: string; random?: (length: number) => Uint8Array } = {}): Promise<{ patch: DevicePatch; removed?: DeviceSlot; frame: DeviceFrame }> {
  if (!record || record.state !== "active") throw new SetMoveRefusal("state", "Only the active device removes a device.");
  if (!record.d || record.ownSlot === undefined || !record.deviceSet[record.ownSlot]) throw new SetMoveRefusal("state", "This device has no device set.");
  const own = record.deviceSet[record.ownSlot]!;
  if (own.key !== toBase64Url(signer.publicKey)) throw new SetMoveRefusal("key", "This device's signing key is not the one its device set names.");
  const slots: (DeviceSlot | null)[] = Array.from({ length: MAX_DEVICES }, (_, i) => record.deviceSet[i] ?? null);
  let removed: DeviceSlot | undefined;
  if (options.remove !== undefined) {
    if (options.remove === own.key) throw new SetMoveRefusal("self", "The active device cannot remove itself.");
    const at = slots.findIndex((slot) => slot?.key === options.remove);
    if (at < 0) throw new SetMoveRefusal("device", "That device is not in this profile's device set.");
    removed = slots[at]!;
    slots[at] = null;
  }
  const random = options.random ?? randomBytes;
  const d = options.random ? random(32) : newDeviceSetSecret();
  const oldKeys = turnKeys(fromBase64Url(record.d)), newKeys = turnKeys(d);
  const sign = (bytes: Uint8Array) => signer.sign(bytes);
  const turnSlots = slots.map((slot) => slot && { key: fromBase64Url(slot.key), name: slot.name });
  const tomb = await signTombstone(oldKeys, record.ownSlot, turnSlots, sign, { instance: random(8) });
  // The first record at the new address: this device active, in its own slot, at the turn it holds. No release: a
  // reader that holds no record of a set takes its first valid record as current.
  const turn = record.turn;
  const packet = await signTurnPacket(newKeys, { turn, rev: FIRST_REV, author: record.ownSlot, active: record.ownSlot, slots: turnSlots, instance: random(8) }, sign);
  const update = { d, set: turnSlots, turn, rev: FIRST_REV };
  // The frame carries this device's last record at the old address: a device that stays and did not see the turn handed
  // to this device reads there only the tombstone now, and checks the release in this record instead (`setUpdate.ts`).
  const rec = record.turnPacket ? fromBase64Url(record.turnPacket) : undefined;
  const frame = await setUpdateFrame(oldKeys.address, { ...update, tomb, ...(rec ? { rec } : {}) }, signer);
  const staying = (keys: readonly string[]) => keys.filter((key) => key !== own.key && slots.some((slot) => slot?.key === key));
  // Frames of earlier sets still waiting for a device that stays: signed again with the newest secret, over their own tombstone.
  const earlier: EarlierDeviceSet[] = [];
  for (const set of record.earlierSets) {
    const pending = staying(set.pending);
    // Its record at that older address stays what the first frame carried.
    let oldRec: Uint8Array | undefined;
    try { const was = JSON.parse(set.setUpdate) as { rec?: unknown }; if (typeof was.rec === "string") oldRec = fromBase64Url(was.rec); } catch { /* none */ }
    const setUpdate = pending.length
      ? JSON.stringify(await setUpdateFrame(turnKeys(fromBase64Url(set.d)).address, { ...update, tomb: fromBase64Url(set.tombstone), ...(oldRec ? { rec: oldRec } : {}) }, signer))
      : set.setUpdate;
    earlier.push({ ...set, pending, setUpdate });
  }
  earlier.push({ d: record.d, tombstone: toBase64Url(tomb), setUpdate: JSON.stringify(frame), pending: staying(slots.flatMap((slot) => (slot ? [slot.key] : []))) });
  return {
    removed, frame,
    patch: {
      d: toBase64Url(d), deviceSet: slots, turn, rev: FIRST_REV, turnPacket: toBase64Url(packet), activeSlot: record.ownSlot,
      // The mark belongs to the old address; nothing has been seen at the new one.
      seenSequence: 0, settle: undefined, earlierSets: earlier.slice(-MAX_EARLIER_SETS),
      // Every grant that never finished is covered: none of those devices gets `D'`. And the offer is answered.
      unfinishedGrants: undefined, secretOffer: undefined,
    },
  };
}

/**
 * Removes the device with signing key `remove`, or (with none) moves the set to a new secret with nobody removed. The
 * write is stored before anything is put or sent; then the new record and the tombstones are put, and the links
 * deliver the frame. A step that fails after the write is not undone: `resumeSetMove` runs it again.
 */
export async function moveSet(ports: SetMovePorts, options: { remove?: string } = {}): Promise<SetMoveReport> {
  const before = await ports.read();
  const plan = await planSetMove(before, ports.signer, { remove: options.remove, random: ports.random });
  ports.crash?.("planned");
  const record = await ports.amend(plan.patch);
  ports.crash?.("stored");
  const report = await resumeSetMove(ports, record);
  return { ...report, ...(plan.removed ? { removed: plan.removed } : {}) };
}

/**
 * Steps 3 to 5 from what the record holds: the stored record put at its address, every earlier set's tombstone put at
 * its old one, and the links brought in line (they send each pending frame on the next session). Run after a move, at
 * every start of the active device, and every hour for the tombstones. Safe to run again: the same bytes go out.
 */
export async function resumeSetMove(ports: SetMovePorts, given?: DeviceRecord): Promise<Omit<SetMoveReport, "removed">> {
  let record = given ?? await ports.read();
  if (!record || record.state !== "active" || !record.d || !record.turnPacket) throw new SetMoveRefusal("state", "Only the active device puts its device set's records.");
  let turnPut: TurnSourcePut[] = [];
  if (ports.network) turnPut = await putPacket(ports.network, turnKeys(fromBase64Url(record.d)), fromBase64Url(record.turnPacket), ports.signer.publicKey);
  ports.crash?.("turn-put");
  let tombstones: TombstonePut[] = [];
  if (ports.network) {
    tombstones = await putTombstones(ports.network, record, ports.signer.publicKey);
    // Another tombstone in place of one of ours: not put again, and the person is told.
    const foreign = new Set(tombstones.filter((put) => put.foreign).map((put) => put.d));
    if (foreign.size) record = await ports.amend({ earlierSets: record.earlierSets.map((set) => (foreign.has(set.d) ? { ...set, foreign: true as const } : set)) });
  }
  ports.crash?.("tombstone-put");
  await ports.refresh?.();
  return { record, turnPut, tombstones };
}

/** A packet put at one address, each source on what it held at a read made just before (WISP 06 § Publishing and reading). */
async function putPacket(network: TurnNetwork, keys: TurnKeys, payload: Uint8Array, ownKey: Uint8Array): Promise<TurnSourcePut[]> {
  const answers = await network.turnRead(keys.identity.pubKeyZ32);
  const read = classifyTurnRead({ keys, ownKey, stored: null }, answers);
  if (!Object.keys(read.conditions).length) return [];
  return network.turnPut(keys.identity.pubKeyZ32, payload, read.conditions);
}

/** What one tombstone's put found. `foreign`: another valid tombstone stands there, and ours was not put. */
export interface TombstonePut { d: string; puts: TurnSourcePut[]; foreign?: true }

/**
 * Step 4: the tombstone of every earlier set, at its old address. One that already stands there is put again byte for
 * byte (an identical packet only refreshes it). When a different valid tombstone stands in its place, ours is not put
 * (WISP 06: "it shows '<device> started a device set of its own', and stops putting its own"): the tombstones do not
 * ping-pong. A set already marked `foreign` is skipped.
 */
export async function putTombstones(network: TurnNetwork, record: DeviceRecord, ownKey: Uint8Array): Promise<TombstonePut[]> {
  const out: TombstonePut[] = [];
  for (const set of record.earlierSets) {
    if (set.foreign) continue;
    const keys = turnKeys(fromBase64Url(set.d));
    const tomb = fromBase64Url(set.tombstone);
    try {
      const answers = await network.turnRead(keys.identity.pubKeyZ32);
      const read = classifyTurnRead({ keys, ownKey, stored: null }, answers);
      if (read.result === "tombstone" && read.payload && !bytesEqual(read.payload, tomb)) { out.push({ d: set.d, puts: [], foreign: true }); continue; }
      if (!Object.keys(read.conditions).length) { out.push({ d: set.d, puts: [] }); continue; }
      out.push({ d: set.d, puts: await network.turnPut(keys.identity.pubKeyZ32, tomb, read.conditions) });
    } catch { out.push({ d: set.d, puts: [] }); }
  }
  return out;
}

/** The frames this device still has to hand over: each earlier set's frame, to each staying device that has not acknowledged it. */
export function pendingFrames(record: DeviceRecord | null): { d: string; key: string; frame: DeviceFrame }[] {
  if (!record || record.state === "removed") return [];
  const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
  return record.earlierSets.flatMap((set) => set.pending.filter((key) => listed.has(key)).flatMap((key) => {
    try { return [{ d: set.d, key, frame: JSON.parse(set.setUpdate) as DeviceFrame }]; } catch { return []; }
  }));
}

/**
 * The record once `key` acknowledged the frame of the set under `d` (a `set-ack` on that old link), or of every set
 * (`d` absent: the device showed up on a link under the current secret, so it holds it). Null when nothing changes.
 */
export function acknowledged(record: DeviceRecord | null, key: string, d?: string): DevicePatch | null {
  if (!record?.earlierSets.some((set) => (d === undefined || set.d === d) && set.pending.includes(key))) return null;
  return { earlierSets: record.earlierSets.map((set) => ((d === undefined || set.d === d) ? { ...set, pending: set.pending.filter((k) => k !== key) } : set)) };
}
