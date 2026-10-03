import {
  TURN_SETTLE_MS, bytesEqual, classifyTurnRead, fromBase64Url, handoffAttemptAllowed, handoffAttemptFailed, handoffAttemptSucceeded, handoffRetryAfter, newDeviceSetSecret,
  randomBytes, readTurnPacket, signTombstone, signTurnPacket, toBase64Url, turnKeys, type TurnNetwork, type TurnRead, type TurnSigner,
} from "@ghostly/core";
import { pendingRaise } from "./raise";
import { MAX_DEVICES, MAX_EARLIER_SETS, type DevicePatch, type DeviceRecord, type DeviceSlot, type OwnSetPlan, type StoredDeviceState } from "./state";
import { TakeoverRefusal, takeoverTarget } from "./takeover";

/*
 * When the remover is gone for good (WISP 06 § Removing a device). A device that reads a tombstone that still lists it
 * is `moving`: it waits for the remover's `set-update`, which comes over an old link. If the remover was lost or broken
 * right after it put the tombstone, nothing will ever come, and the device would wait for ever. "My other device is
 * lost or broken" is its way out: it makes a device set of its own, from its frozen copy, as a forced takeover does.
 *
 * 1. The same checks as a forced takeover: a copy here, the lock password (against the verifier the active device left)
 *    with its limits, and the name of the device that stops (the remover) typed.
 * 2. A new random device-set secret, a tombstone for the old address that lists only this device, and the first record
 *    at the new address, all stored in one durable write before anything leaves the device. A reload from here resumes.
 * 3. The tombstone is put at the old address, on what each source held.
 * 4. It waits `T` from the end of the put, reads every source again, and counts the read only if every source that took
 *    the put answers. Every tombstone has one sequence, and at an equal sequence a DHT node keeps the packet that came
 *    last and a relay the one that compares larger; with the wait, two devices that did this at once read the same packet
 *    when they read the same sources, and the lower `instance` counts for both (`classifyTurnRead`).
 * 5. Its own tombstone there: it is `active` in the new set, alone, with one more takeover and its counters raised before
 *    the engine starts; the old address is put again every hour as an earlier set's, and a tombstone found in its place
 *    there stops those puts and tells the person (`remove.ts`). Another valid tombstone that does not list it: `removed`
 *    (a second `moving` device did the same first). One that still lists it (the remover's came back on top): it stays
 *    `moving`, and may try again.
 *
 * The other devices must be added again: the person is told so before, and they hold the old secret only.
 */

export interface OwnSetPorts {
  read(): Promise<DeviceRecord | null>;
  amend(patch: DevicePatch): Promise<DeviceRecord>;
  move(to: StoredDeviceState, patch?: DevicePatch): Promise<DeviceRecord>;
  /** Whether `password` is the one the verifier checks (`provesHandoffPassword`). */
  proves(verifier: NonNullable<DeviceRecord["verifier"]>, password: string): Promise<boolean>;
  /** Signs with this device's signing key. */
  signer: TurnSigner;
  /** The turn record's sources; null offline. */
  network: TurnNetwork | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: (length: number) => Uint8Array;
}

/**
 * `start`: this device is the active one of a set of its own now (the pages start again into the gate). `removed`:
 * another device of the old set did the same first. `lost`: the remover's tombstone stands; still `moving`. `wait`: no
 * read that counts yet (offline, or a source that took the put did not answer); the plan is kept and resumed.
 */
export type OwnSetOutcome = "start" | "removed" | "lost" | "wait";

/** Whether this device may offer it: `moving`, a copy here, and a remover it still believes (not one it can only be added back from). */
export function canStartOwnSet(record: DeviceRecord | null): boolean {
  return !!record && record.state === "moving" && !!record.copy && !record.reenroll;
}

/**
 * "My other device is lost or broken" on a `moving` device. Checks the request, writes the plan, puts the tombstone and
 * settles. Throws `TakeoverRefusal` before anything is written.
 */
export async function startOwnSet(ports: OwnSetPorts, request: { password: string; name: string }): Promise<OwnSetOutcome> {
  const now = ports.now ?? Date.now;
  const record = await ports.read();
  if (!record || record.state !== "moving") throw new TakeoverRefusal("state", "Only a device that waits for its devices' new secret starts a set of its own.");
  if (record.ownSet) return resumeOwnSet(ports);
  if (!record.copy) throw new TakeoverRefusal("no-copy", "This device holds no copy of the profile.");
  // What the screen offers is what is allowed here too: a device that can only be added back makes no set of its own.
  if (!canStartOwnSet(record)) throw new TakeoverRefusal("state", "This device cannot start a device set of its own.");
  const allowed = handoffAttemptAllowed(record.takeoverAttempts, now());
  if (allowed !== "ok") throw new TakeoverRefusal(allowed, allowed === "locked-out" ? "Too many tries. Try again later." : "Too many tries on this device.", allowed === "locked-out" ? handoffRetryAfter(record.takeoverAttempts, now()) : undefined);
  if (record.copy === "frozen" || record.verifier) {
    if (!record.verifier) throw new TakeoverRefusal("no-password", "This device cannot check the profile's password yet.");
    if (typeof request.password !== "string" || !request.password) throw new TakeoverRefusal("password", "Type the profile's password.");
    if (!(await ports.proves(record.verifier, request.password).catch(() => false))) {
      await ports.amend({ takeoverAttempts: handoffAttemptFailed(record.takeoverAttempts, now()) });
      throw new TakeoverRefusal("password", "Wrong password.");
    }
  }
  const target = takeoverTarget(record);
  const same = (a: string, b: string) => a.normalize("NFC").trim().toLocaleLowerCase() === b.normalize("NFC").trim().toLocaleLowerCase();
  if (target && (typeof request.name !== "string" || !same(request.name, target))) throw new TakeoverRefusal("name", `Type ${target} to confirm.`);
  if (!ports.network) throw new TakeoverRefusal("offline", "Go online to take over.");
  if (record.takeoverAttempts && (record.takeoverAttempts.total > 0 || record.takeoverAttempts.recent.length)) await ports.amend({ takeoverAttempts: handoffAttemptSucceeded() });
  // What stands at the old address now: the remover's tombstone, which this one has to outrank (below).
  if (!record.d || record.ownSlot === undefined || !record.deviceSet[record.ownSlot]) throw new TakeoverRefusal("state", "This device has no device set.");
  const keys = turnKeys(fromBase64Url(record.d));
  const standing = classifyTurnRead({ keys, ownKey: fromBase64Url(record.deviceSet[record.ownSlot]!.key), stored: null }, await ports.network.turnRead(keys.identity.pubKeyZ32));
  if (!standing.good) return "wait";
  // A tombstone that no longer lists this device: another device of the old set made a set of its own first.
  if (standing.result === "tombstone" && !standing.listed) { await ports.move("removed", {}); return "removed"; }
  await ports.amend({ ownSet: await planOwnSet(record, ports, standing.result === "tombstone" ? standing.record?.instance : undefined) });
  return resumeOwnSet(ports);
}

/**
 * An instance below `under` (8 bytes, compared as a number), random within that: at the one sequence every tombstone
 * has, the lower `instance` is the one every reader counts, and the tombstone of a remover that is gone must not keep
 * this one from counting for ever. A second `moving` device does the same, and the lower of the two counts, for both.
 */
export function instanceBelow(under: Uint8Array | undefined, random: (length: number) => Uint8Array = randomBytes): Uint8Array {
  const fresh = random(8);
  if (!under || under.length !== 8) return fresh;
  const limit = under.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  if (limit === 0n) return fresh;
  let value = fresh.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n) % limit;
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { out[i] = Number(value & 0xffn); value >>= 8n; }
  return out;
}

/**
 * Step 2: the new secret, the tombstone that lists only this device (with an instance below `under`, the tombstone that
 * stands at the old address), and the first record at the new address.
 */
export async function planOwnSet(record: DeviceRecord, ports: Pick<OwnSetPorts, "signer" | "random">, under?: Uint8Array): Promise<OwnSetPlan> {
  if (!record.d || record.ownSlot === undefined || !record.deviceSet[record.ownSlot]) throw new TakeoverRefusal("state", "This device has no device set.");
  const random = ports.random ?? randomBytes;
  const d = ports.random ? random(32) : newDeviceSetSecret();
  const own = record.deviceSet[record.ownSlot]!;
  const slots = Array.from({ length: MAX_DEVICES }, (_, i) => (i === record.ownSlot ? { key: fromBase64Url(own.key), name: own.name } : null));
  const tombstone = await signTombstone(turnKeys(fromBase64Url(record.d)), record.ownSlot, slots, ports.signer, { instance: instanceBelow(under, random) });
  const packet = await signTurnPacket(turnKeys(d), { turn: record.turn, rev: 0, author: record.ownSlot, active: record.ownSlot, slots, instance: random(8) }, ports.signer);
  return { d: toBase64Url(d), tombstone: toBase64Url(tombstone), packet: toBase64Url(packet), at: null, sources: [] };
}

/**
 * Steps 3 to 5 from the stored plan: what a reload while it settles runs again. A put whose end was never stored is
 * made again (the same bytes); the wait counts from its end.
 */
export async function resumeOwnSet(ports: OwnSetPorts): Promise<OwnSetOutcome> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let record = await ports.read();
  const plan = record?.ownSet;
  // The remover's new secret reached this device after all (it is a standby of that set now): the plan is void.
  if (record && plan && record.state !== "moving") { await ports.amend({ ownSet: undefined }); return "lost"; }
  if (!record || record.state !== "moving" || !plan || !record.d || record.ownSlot === undefined) return "wait";
  if (!ports.network) return "wait";
  const keys = turnKeys(fromBase64Url(record.d));
  const own = fromBase64Url(record.deviceSet[record.ownSlot]!.key);
  const tomb = fromBase64Url(plan.tombstone);
  const readOld = async (): Promise<TurnRead> => classifyTurnRead({ keys, ownKey: own, stored: null }, await ports.network!.turnRead(keys.identity.pubKeyZ32));
  let at = plan.at, sources = plan.sources;
  if (at === null) {
    const before = await readOld();
    if (!Object.keys(before.conditions).length) return "wait";
    const puts = await ports.network.turnPut(keys.identity.pubKeyZ32, tomb, before.conditions);
    at = now(); sources = puts.filter((put) => put.outcome === "stored").map((put) => put.source);
    if (!sources.length) return "wait";
    await ports.amend({ ownSet: { ...plan, at, sources } });
  }
  const due = at + TURN_SETTLE_MS;
  if (now() < due) await sleep(due - now());
  // While it waited the device may have taken the remover's new secret (a `set-update`) or read another tombstone.
  const fresh = await ports.read();
  if (!fresh || fresh.state !== "moving" || fresh.ownSet?.d !== plan.d) {
    if (fresh?.ownSet) await ports.amend({ ownSet: undefined });
    return fresh?.state === "removed" ? "removed" : "lost";
  }
  record = fresh;
  const read = await readOld();
  if (!sources.every((source) => read.conditions[source] !== undefined)) return "wait";
  if (read.result !== "tombstone" || !read.payload) return "wait";
  if (bytesEqual(read.payload, tomb)) { await won(ports, record, plan, now()); return "start"; }
  // Another tombstone counts there. One that does not list this device: another device of the old set made its own first.
  if (!read.listed) { await ports.move("removed", { ownSet: undefined }); return "removed"; }
  await ports.amend({ ownSet: undefined });
  return "lost";
}

/** Its own tombstone counts: `active`, alone, in the new set, in one write with the raise its counters need. */
async function won(ports: OwnSetPorts, record: DeviceRecord, plan: OwnSetPlan, at: number): Promise<void> {
  const own = record.deviceSet[record.ownSlot!]!;
  const deviceSet: (DeviceSlot | null)[] = Array.from({ length: MAX_DEVICES }, (_, i) => (i === record.ownSlot ? own : null));
  const takeovers = record.takeovers + 1;
  const earlierSets = [...record.earlierSets.filter((set) => set.d !== record.d), { d: record.d!, tombstone: plan.tombstone, setUpdate: "", pending: [] }].slice(-MAX_EARLIER_SETS);
  await ports.move("active", {
    d: plan.d, deviceSet, turn: record.turn, rev: 0, turnPacket: plan.packet, activeSlot: record.ownSlot, seenSequence: 0, settle: undefined, earlierSets,
    takeovers, raise: pendingRaise("takeover", takeovers, at), copy: undefined, tombstone: undefined, reenroll: undefined, ownSet: undefined, setNotice: undefined,
    handoff: undefined, unfinishedGrants: undefined, secretOffer: undefined,
    // Its own subscription stays its own; what it knew of the other devices goes with the old set.
    push: record.push?.own ? { own: { ...record.push.own, tokens: {} } } : undefined,
  });
}

/**
 * A device that put a tombstone of its own (a set of its own, settling) and then took the remover's new secret after all
 * (a `set-update`): its tombstone, which lists only itself, would make every other device left at the old address
 * `removed`, with no remover's frame able to bring it back. It puts in its place a tombstone that lists the devices the
 * remover's lists (`removerTomb`), signed from its own slot there, with an instance below what stands, so it counts:
 * the others stay `moving` and take the remover's frame. The remover takes a tombstone that lists its own staying
 * devices for its own (`remove.ts`). True when one was put.
 */
export async function supersedeOwnTombstone(ports: Pick<OwnSetPorts, "signer" | "network" | "random">, before: DeviceRecord, removerTomb: Uint8Array): Promise<boolean> {
  if (!ports.network || !before.ownSet || !before.d || before.ownSlot === undefined) return false;
  const keys = turnKeys(fromBase64Url(before.d));
  const remover = readTurnPacket(keys, removerTomb);
  if (remover.kind !== "valid" || !remover.record.tombstone) return false;
  const own = before.deviceSet[before.ownSlot];
  const ownSlot = remover.record.slots.findIndex((slot) => !!slot && !!own && toBase64Url(slot.key) === own.key);
  if (ownSlot < 0) return false;
  const standing = classifyTurnRead({ keys, ownKey: fromBase64Url(own!.key), stored: null }, await ports.network.turnRead(keys.identity.pubKeyZ32));
  if (!Object.keys(standing.conditions).length) return false;
  const tomb = await signTombstone(keys, ownSlot, remover.record.slots, ports.signer, { instance: instanceBelow(standing.result === "tombstone" ? standing.record?.instance : undefined, ports.random) });
  const puts = await ports.network.turnPut(keys.identity.pubKeyZ32, tomb, standing.conditions);
  return puts.some((put) => put.outcome === "stored");
}
