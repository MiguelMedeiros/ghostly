import { beforeEach, describe, expect, it } from "vitest";
import {
  fromBase64Url, readSetUpdate, readTurnPacket, seedSigner, setUpdateFrame, signTombstone, signTurnPacket, toBase64Url, turnKeys, verifySetUpdate,
  type DeviceFrame, type Signer, type TurnConditions, type TurnNetwork, type TurnRecord, type TurnSourceAnswer, type TurnSourcePut,
} from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type DeviceSlot, type StoredDeviceState } from "../src/devices/state";
import { TurnKeeper, type TurnStore } from "../src/devices/turn";
import { SetMoveRefusal, acknowledged, moveSet, pendingFrames, planSetMove, putTombstones, resumeSetMove, type SetMovePorts, type SetMoveStep } from "../src/devices/remove";
import { checkSetUpdate } from "../src/devices/setUpdate";
import { newDeviceSecretDue } from "../src/devices/rotate";
import { viewOf } from "../src/devices/gate";
import { enrollmentUnfinished } from "../src/devices/enroll";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.remove, devices.remove.moving

/*
 * Removing a device and "New device secret" (WISP 06 § Removing a device), as the active device does them and as the
 * devices that stay take them: the one durable write before anything leaves, a crash at every step after it resumed
 * from the record alone, the frame delivered until each staying device answers, and the rule a `moving` device follows
 * (only its stored active device's signature, and only while the tombstone still lists that device). Every key and
 * secret here is made in the test.
 */

/** The sources of every turn address, one fake per address: the old address and the new one are told apart. */
class Network implements TurnNetwork {
  readonly at = new Map<string, FakeTurnNetwork>();
  down = false;
  of(z32: string): FakeTurnNetwork {
    let net = this.at.get(z32);
    if (!net) this.at.set(z32, (net = new FakeTurnNetwork()));
    return net;
  }
  held(keys: { identity: { pubKeyZ32: string } }): Uint8Array | null { return this.at.get(keys.identity.pubKeyZ32)?.source("dht").held ?? null; }
  async turnRead(z32: string): Promise<TurnSourceAnswer[]> {
    if (this.down) return [{ source: "dht", answered: false, payloads: [] }];
    return this.of(z32).turnRead(z32);
  }
  async turnPut(z32: string, payload: Uint8Array, conditions: TurnConditions): Promise<TurnSourcePut[]> { return this.of(z32).turnPut(z32, payload, conditions); }
}

const label = (n: number) => new Uint8Array(32).fill(n);
const signers: Signer[] = [1, 2, 3, 4].map((n) => seedSigner(label(60 + n)));
const NAMES = ["Desktop", "Phone", "Tablet", "Laptop"];
const OLD_D = label(0xd1);
const oldKeys = turnKeys(OLD_D);
const N = 4_242;
const slot = (i: number): DeviceSlot => ({ key: toBase64Url(signers[i].publicKey), name: NAMES[i] });
const sign = (i: number) => (bytes: Uint8Array) => signers[i].sign(bytes);

function memory(initial: DeviceRecord): TurnStore & { record: DeviceRecord } {
  const store = {
    record: initial,
    read: async () => store.record,
    amend: async (_profile: string, patch: DevicePatch) => (store.record = { ...amend(store.record, patch), saved: store.record.saved + 1 }),
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => (store.record = { ...transition(store.record, profile, to, patch), saved: store.record.saved + 1 }),
  };
  return store;
}

/** The active device's record at turn `N` under the old secret, with `count` devices; its packet is on the network. */
async function setOf(network: Network, count = 3, patch: DevicePatch = {}) {
  const set = Array.from({ length: count }, (_, i) => slot(i));
  const packet = await signTurnPacket(oldKeys, { turn: N, rev: 2, author: 0, active: 0, slots: [0, 1, 2, 3].map((i) => (i < count ? { key: signers[i].publicKey, name: NAMES[i] } : null)), instance: label(9).slice(0, 8) }, sign(0));
  network.of(oldKeys.identity.pubKeyZ32).seed(packet);
  const record = (own: number, state: StoredDeviceState): DeviceRecord => ({
    ...firstRecord("ghostly", "standby", { turn: N, rev: 2, d: toBase64Url(OLD_D), deviceSet: set, ownSlot: own, activeSlot: 0, turnPacket: toBase64Url(packet), seenSequence: Number(readTurnPacket(oldKeys, packet).kind === "valid" ? (readTurnPacket(oldKeys, packet) as { sequence: bigint }).sequence : 0n), ...patch }),
    state, saved: 1,
  });
  return { packet, record };
}

function ports(store: ReturnType<typeof memory>, network: TurnNetwork | null, crashAt?: SetMoveStep): SetMovePorts & { refreshed: number } {
  const out = {
    refreshed: 0,
    read: () => store.read(),
    amend: (patch: DevicePatch) => store.amend("ghostly", patch),
    signer: signers[0], network,
    refresh: async () => { out.refreshed++; },
    crash: (point: SetMoveStep) => { if (point === crashAt) throw new Error(`crash at ${point}`); },
  };
  return out;
}

const opened = (keys: ReturnType<typeof turnKeys>, payload: Uint8Array | null): TurnRecord => {
  const read = readTurnPacket(keys, payload!);
  if (read.kind !== "valid") throw new Error(`not a record: ${read.kind}`);
  return read.record;
};
const keysOf = (record: DeviceRecord) => turnKeys(fromBase64Url(record.d!));

/** A device's keeper over its own memory store, signing with its own key. */
const keeperOf = (store: ReturnType<typeof memory>, network: TurnNetwork, i: number) =>
  new TurnKeeper({ profile: "ghostly", network, store, signer: sign(i), now: () => 1_000_000, sleep: async () => {} });

/**
 * What a device that stays does with a frame (`links.ts`, without the link): the rule, then the write, then the
 * answer. Returns whether it answered `set-ack`.
 */
async function deliver(store: ReturnType<typeof memory>, frame: DeviceFrame): Promise<boolean> {
  const check = checkSetUpdate(store.record, frame, 5_000);
  if (check.kind === "known") return true;
  if (check.kind === "refuse") {
    if (check.why === "removed") await store.move("ghostly", "removed", {});
    else if (check.reenroll && store.record.state === "moving") await store.amend("ghostly", { reenroll: true });
    return false;
  }
  if (check.from === "superseded") await store.move("ghostly", "moving", {});
  if (check.from === "standby") await store.amend("ghostly", check.patch);
  else await store.move("ghostly", "standby", check.patch);
  return true;
}

let network: Network;
beforeEach(() => { network = new Network(); });

describe("planning a removal", () => {
  it("is the active device's alone, never of itself, and only of a device in the set", async () => {
    const { record } = await setOf(network);
    await expect(planSetMove(record(1, "standby"), signers[1], { remove: slot(2).key })).rejects.toThrow(SetMoveRefusal);
    await expect(planSetMove(record(0, "active"), signers[0], { remove: slot(0).key })).rejects.toThrow("remove-self");
    await expect(planSetMove(record(0, "active"), signers[0], { remove: toBase64Url(label(77)) })).rejects.toThrow("remove-device");
    await expect(planSetMove(record(0, "active"), signers[1], { remove: slot(2).key })).rejects.toThrow("remove-key");
  });

  it("makes a new secret, a tombstone that keeps the staying devices, the new set's first record and one signed frame", async () => {
    const { record } = await setOf(network);
    const active = record(0, "active");
    const plan = await planSetMove(active, signers[0], { remove: slot(2).key });
    expect(plan.removed).toEqual(slot(2));
    const d = fromBase64Url(plan.patch.d!);
    expect(plan.patch.d).not.toBe(active.d);
    expect(d).toHaveLength(32);
    expect(plan.patch.deviceSet).toEqual([slot(0), slot(1), null, null]);
    expect(plan.patch.seenSequence).toBe(0);
    // The new set's record: this device active in its slot, at its turn, rev 0, with the removed device's slot empty.
    const first = opened(turnKeys(d), fromBase64Url(plan.patch.turnPacket!));
    expect({ turn: first.turn, rev: first.rev, author: first.author, active: first.active, release: first.release }).toEqual({ turn: N, rev: 0, author: 0, active: 0, release: undefined });
    expect(first.slots[2]).toBeNull();
    // The tombstone closes the old address and lists the devices that stay; the frame carries it, signed for that address.
    const earlier = plan.patch.earlierSets!.at(-1)!;
    expect(earlier).toMatchObject({ d: active.d, pending: [slot(1).key] });
    const tomb = opened(oldKeys, fromBase64Url(earlier.tombstone));
    expect(tomb.tombstone).toBe(true);
    expect(tomb.slots.map((s) => s && toBase64Url(s.key))).toEqual([slot(0).key, slot(1).key, null, null]);
    const update = readSetUpdate(JSON.parse(earlier.setUpdate) as DeviceFrame)!;
    expect(verifySetUpdate(update, oldKeys.address)).toBe(true);
    expect(toBase64Url(update.d)).toBe(plan.patch.d);
  });
});

describe("a removal from start to end", () => {
  it("stores everything first, then the new record and the tombstone go out; the removed device reads removed, a staying one moving, then takes the frame", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active")), phone = memory(record(1, "standby")), tablet = memory(record(2, "standby"));
    const report = await moveSet(ports(desktop, network), { remove: slot(2).key });
    expect(report.removed).toEqual(slot(2));
    const newKeys = keysOf(desktop.record);
    expect(opened(newKeys, network.held(newKeys)).active).toBe(0);
    expect(opened(oldKeys, network.held(oldKeys)).tombstone).toBe(true);

    // The removed device reads the old address at its next turn read: removed, and no frame is for it.
    const tabletOutcome = await keeperOf(tablet, network, 2).check(false);
    expect(tabletOutcome).toMatchObject({ kind: "gated", state: "removed" });
    expect(tablet.record.state).toBe("removed");
    expect(pendingFrames(desktop.record).map((p) => p.key)).toEqual([slot(1).key]);

    // The phone was off; it reads the tombstone that still lists it: moving, with the tombstone kept, waiting for the frame.
    expect(await keeperOf(phone, network, 1).check(false)).toMatchObject({ kind: "gated", state: "moving" });
    expect(phone.record.tombstone).toBe(toBase64Url(network.held(oldKeys)!));
    expect(phone.record.reenroll).toBeUndefined();
    expect(viewOf(phone.record)).toMatchObject({ state: "moving", activeDevice: "Desktop" });

    // The frame reaches it over the old link: accepted, standby under the new secret, the list shown once.
    const [{ frame }] = pendingFrames(desktop.record);
    expect(await deliver(phone, frame)).toBe(true);
    expect(phone.record).toMatchObject({ state: "standby", d: desktop.record.d, activeSlot: 0, deviceSet: [slot(0), slot(1), null, null], setNotice: { names: ["Desktop", "Phone"] } });
    expect(phone.record.turnPacket).toBeUndefined();
    // Not an enrollment that did not finish, though it holds no packet of the new set yet.
    expect(enrollmentUnfinished(phone.record)).toBe(false);
    expect(viewOf(phone.record)).toMatchObject({ state: "standby", notice: ["Desktop", "Phone"] });
    expect(viewOf(phone.record).unfinished).toBeUndefined();
    // Its next turn read is of the new address: it keeps the remover's record there.
    expect(await keeperOf(phone, network, 1).check(false)).toMatchObject({ kind: "show", screen: "active-on", device: "Desktop" });
    expect(phone.record.turnPacket).toBe(toBase64Url(network.held(newKeys)!));
    // Acknowledged: nothing is pending any more.
    desktop.record = { ...amend(desktop.record, acknowledged(desktop.record, slot(1).key, record(0, "active").d)!), saved: desktop.record.saved + 1 };
    expect(pendingFrames(desktop.record)).toEqual([]);
  });

  it("a device that already holds the new secret only answers", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active")), phone = memory(record(1, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const [{ frame }] = pendingFrames(desktop.record);
    expect(await deliver(phone, frame)).toBe(true);
    const saved = phone.record.saved;
    expect(await deliver(phone, frame)).toBe(true);
    expect(phone.record.saved).toBe(saved);
  });
});

describe("a crash of the remover at every step", () => {
  /** Runs a removal that crashes at `point`, then what the next start does, and checks the end state is the same as with no crash. */
  async function crashedAt(point: SetMoveStep) {
    const { record } = await setOf(network);
    const before = record(0, "active");
    const desktop = memory(before);
    await expect(moveSet(ports(desktop, network, point), { remove: slot(2).key })).rejects.toThrow(`crash at ${point}`);
    return { desktop, before };
  }

  it("before the write: nothing happened, and nothing left the device", async () => {
    const { desktop, before } = await crashedAt("planned");
    expect(desktop.record).toEqual(before);
    expect(opened(oldKeys, network.held(oldKeys)).tombstone).toBe(false);
    expect(network.at.size).toBe(1);
  });

  for (const point of ["stored", "turn-put"] as const) {
    it(`after the write and before the tombstone's put (${point}): the next start puts what was stored, byte for byte`, async () => {
      const { desktop } = await crashedAt(point);
      const newKeys = keysOf(desktop.record);
      expect(opened(oldKeys, network.held(oldKeys)).tombstone).toBe(false);
      if (point === "stored") expect(network.held(newKeys)).toBeNull();
      const resumed = ports(desktop, network);
      await resumeSetMove(resumed);
      expect(toBase64Url(network.held(newKeys)!)).toBe(desktop.record.turnPacket);
      expect(toBase64Url(network.held(oldKeys)!)).toBe(desktop.record.earlierSets.at(-1)!.tombstone);
      expect(resumed.refreshed).toBe(1);
      expect(pendingFrames(desktop.record).map((p) => p.key)).toEqual([slot(1).key]);
    });
  }

  it("after the tombstone's put: running again puts the same bytes, and the frame is still pending", async () => {
    const { desktop } = await crashedAt("tombstone-put");
    const tomb = network.held(oldKeys);
    expect(opened(oldKeys, tomb).tombstone).toBe(true);
    const report = await resumeSetMove(ports(desktop, network));
    expect(report.tombstones[0].puts.every((put) => put.outcome === "stored")).toBe(true);
    expect(network.held(oldKeys)).toEqual(tomb);
    expect(pendingFrames(desktop.record)).toHaveLength(1);
  });

  it("before and after each set-update: a frame sent again is taken once, and the device is acknowledged once it answers", async () => {
    const { record } = await setOf(network, 4);
    const desktop = memory(record(0, "active"));
    const phone = memory(record(1, "standby")), laptop = memory(record(3, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const oldD = record(0, "active").d!;
    expect(pendingFrames(desktop.record).map((p) => p.key).sort()).toEqual([slot(1).key, slot(3).key].sort());
    // The remover stops before its first frame: on its next start both are still pending, as stored.
    const restarted = memory(desktop.record);
    expect(pendingFrames(restarted.record)).toHaveLength(2);
    // The phone takes it and its answer is lost (the remover stopped after sending): sent again, the phone only answers.
    const toPhone = pendingFrames(restarted.record).find((p) => p.key === slot(1).key)!.frame;
    expect(await deliver(phone, toPhone)).toBe(true);
    const savedPhone = phone.record.saved;
    expect(await deliver(phone, toPhone)).toBe(true);
    expect(phone.record.saved).toBe(savedPhone);
    restarted.record = { ...amend(restarted.record, acknowledged(restarted.record, slot(1).key, oldD)!), saved: restarted.record.saved + 1 };
    // The laptop: the remover stops after its answer was stored; nothing more is sent to it.
    const toLaptop = pendingFrames(restarted.record)[0];
    expect(toLaptop.key).toBe(slot(3).key);
    expect(await deliver(laptop, toLaptop.frame)).toBe(true);
    restarted.record = { ...amend(restarted.record, acknowledged(restarted.record, slot(3).key, oldD)!), saved: restarted.record.saved + 1 };
    expect(pendingFrames(memory(restarted.record).record)).toEqual([]);
    expect(acknowledged(restarted.record, slot(3).key, oldD)).toBeNull();
    // Both hold the new set; the removed slot is empty everywhere.
    for (const device of [phone, laptop]) expect(device.record).toMatchObject({ state: "standby", d: desktop.record.d, deviceSet: [slot(0), slot(1), null, slot(3)] });
  });

  it("a device seen on a link under the new secret is acknowledged for every earlier set", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    expect(acknowledged(desktop.record, slot(1).key)).not.toBeNull();
    desktop.record = { ...amend(desktop.record, acknowledged(desktop.record, slot(1).key)!), saved: desktop.record.saved + 1 };
    expect(pendingFrames(desktop.record)).toEqual([]);
  });
});

describe("who a moving device believes", () => {
  it("refuses a tombstone and frame the removed device made for itself, signed with its own key", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active")), phone = memory(record(1, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    await keeperOf(phone, network, 1).check(false);
    expect(phone.record.state).toBe("moving");
    // The removed tablet still holds the old D: its own tombstone (keeping the phone and itself) and a secret of its own.
    const forgedTomb = await signTombstone(oldKeys, 2, [null, { key: signers[1].publicKey, name: "Phone" }, { key: signers[2].publicKey, name: "Tablet" }, null], sign(2));
    const forged = await setUpdateFrame(oldKeys.address, { d: label(0xee), set: [null, { key: signers[1].publicKey, name: "Phone" }, { key: signers[2].publicKey, name: "Tablet" }], turn: N + 9, rev: 0, tomb: forgedTomb }, signers[2]);
    expect(checkSetUpdate(phone.record, forged, 1)).toEqual({ kind: "refuse", why: "signer", reenroll: true });
    expect(await deliver(phone, forged)).toBe(false);
    expect(phone.record).toMatchObject({ state: "moving", d: toBase64Url(OLD_D), reenroll: true });
    // The same with the real tombstone: still the wrong signer.
    const realTomb = fromBase64Url(desktop.record.earlierSets.at(-1)!.tombstone);
    const relabelled = await setUpdateFrame(oldKeys.address, { d: label(0xee), set: [slot(0), slot(1)].map((s) => ({ key: fromBase64Url(s.key), name: s.name })), turn: N, rev: 0, tomb: realTomb }, signers[2]);
    expect(checkSetUpdate(phone.record, relabelled, 1)).toMatchObject({ kind: "refuse", why: "signer" });
    // A frame whose signature does not verify is refused as well.
    const real = pendingFrames(desktop.record)[0].frame;
    expect(checkSetUpdate(phone.record, { ...real, turn: N + 1 }, 1)).toMatchObject({ kind: "refuse", why: "signature" });
    // The real one, after all that: accepted.
    expect(await deliver(phone, real)).toBe(true);
    expect(phone.record).toMatchObject({ state: "standby", d: desktop.record.d });
    expect(phone.record.reenroll).toBeUndefined();
  });

  it("whose stored active device is the one removed accepts nothing, and is enrolled anew", async () => {
    const { record } = await setOf(network);
    // The phone was off across a handoff: it last saw the tablet active. The desktop took the turn back and removes the tablet.
    const phone = memory({ ...record(1, "standby"), activeSlot: 2 });
    const desktop = memory(record(0, "active"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    expect(await keeperOf(phone, network, 1).check(false)).toMatchObject({ kind: "gated", state: "moving" });
    // The tombstone alone says it: its stored active device is not listed, so nothing can be accepted.
    expect(phone.record.reenroll).toBe(true);
    expect(viewOf(phone.record)).toMatchObject({ state: "moving", reenroll: true });
    const frame = pendingFrames(desktop.record)[0].frame;
    expect(checkSetUpdate(phone.record, frame, 1)).toMatchObject({ kind: "refuse", reenroll: true });
    expect(await deliver(phone, frame)).toBe(false);
    expect(phone.record.state).toBe("moving");
  });

  it("goes to removed on a valid tombstone that no longer lists it, whoever hands it over", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active")), tablet = memory(record(2, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const frame = pendingFrames(desktop.record)[0].frame;
    expect(checkSetUpdate(tablet.record, frame, 1)).toMatchObject({ kind: "refuse", why: "removed" });
    await deliver(tablet, frame);
    expect(tablet.record.state).toBe("removed");
  });

  it("a replaced device takes the frame through moving, and keeps its frozen copy", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active")), phone = memory({ ...record(1, "superseded"), copy: "frozen" });
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    expect(await deliver(phone, pendingFrames(desktop.record)[0].frame)).toBe(true);
    expect(phone.record).toMatchObject({ state: "standby", copy: "frozen", d: desktop.record.d });
  });

  it("refuses in any state that takes no frame, and a frame of another address", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const frame = pendingFrames(desktop.record)[0].frame;
    for (const state of ["active", "releasing", "taking", "removed"] as const) expect(checkSetUpdate(record(1, state), frame, 1)).toMatchObject({ kind: "refuse", why: "state" });
    const elsewhere = { ...record(1, "standby"), d: toBase64Url(label(0x55)) };
    expect(checkSetUpdate(elsewhere, frame, 1)).toMatchObject({ kind: "refuse", why: "tombstone" });
    expect(checkSetUpdate(record(1, "standby"), { t: "set-update" }, 1)).toMatchObject({ kind: "refuse", why: "malformed" });
  });

  it("forwards the frame it took, unchanged, to the other devices that stay", async () => {
    const { record } = await setOf(network, 4);
    const desktop = memory(record(0, "active")), phone = memory(record(1, "standby")), laptop = memory(record(3, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const frame = pendingFrames(desktop.record).find((p) => p.key === slot(1).key)!.frame;
    await deliver(phone, frame);
    // The phone keeps the frame for the laptop (never for the remover or itself), and hands it over as it was signed.
    const forwarded = pendingFrames(phone.record);
    expect(forwarded.map((p) => p.key)).toEqual([slot(3).key]);
    expect(forwarded[0].frame).toEqual(frame);
    await keeperOf(laptop, network, 3).check(false);
    expect(await deliver(laptop, forwarded[0].frame)).toBe(true);
    expect(laptop.record).toMatchObject({ state: "standby", d: desktop.record.d, activeSlot: 0 });
  });
});

describe("New device secret", () => {
  it("is due by itself when a grant never finished, and moves the set with nobody removed: the grant is dropped and its slot is free", async () => {
    const stranger = seedSigner(label(99));
    const { record } = await setOf(network, 2, { unfinishedGrants: [{ key: toBase64Url(stranger.publicKey), name: "Tablet", at: 1 }] });
    const desktop = memory(record(0, "active"));
    expect(newDeviceSecretDue(desktop.record)).toEqual({ why: "unfinished-grant", keys: [toBase64Url(stranger.publicKey)] });
    await moveSet(ports(desktop, network));
    expect(desktop.record.unfinishedGrants).toBeUndefined();
    expect(newDeviceSecretDue(desktop.record)).toBeNull();
    expect(desktop.record.deviceSet).toEqual([slot(0), slot(1), null, null]);
    // The tombstone keeps every listed device; the device that never finished is not listed: it reads removed.
    const tomb = opened(oldKeys, network.held(oldKeys));
    expect(tomb.slots.map((s) => s && toBase64Url(s.key))).toEqual([slot(0).key, slot(1).key, null, null]);
    const grantee = memory({ ...firstRecord("ghostly", "standby", { turn: N, d: toBase64Url(OLD_D), deviceSet: [slot(0), slot(1), { key: toBase64Url(stranger.publicKey), name: "Tablet" }], ownSlot: 2, activeSlot: 0 }), saved: 1 });
    const outcome = await new TurnKeeper({ profile: "ghostly", network, store: grantee, signer: (bytes) => stranger.sign(bytes), sleep: async () => {} }).check(false);
    expect(outcome).toMatchObject({ kind: "gated", state: "removed" });
    // The slot the grant was given is free for the next device added, and nobody who holds the old secret can claim it.
    expect(desktop.record.deviceSet.indexOf(null)).toBe(2);
    // The phone stays: it gets the frame.
    expect(pendingFrames(desktop.record).map((p) => p.key)).toEqual([slot(1).key]);
  });

  it("is offered after a forced takeover, and making it answers the offer", async () => {
    const { record } = await setOf(network, 2, { secretOffer: { why: "takeover", at: 1, device: "Phone" } });
    const desktop = memory(record(0, "active"));
    expect(newDeviceSecretDue(desktop.record)).toEqual({ why: "takeover", keys: [] });
    await moveSet(ports(desktop, network));
    expect(desktop.record.secretOffer).toBeUndefined();
  });

  it("a device off across two moves gets the newest secret over the oldest tombstone", async () => {
    const { record } = await setOf(network, 4);
    const desktop = memory(record(0, "active")), laptop = memory(record(3, "standby"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    const firstD = desktop.record.d;
    await moveSet(ports(desktop, network), { remove: slot(1).key });
    expect(desktop.record.d).not.toBe(firstD);
    // The frame waiting for the laptop under the oldest secret now carries the newest one.
    const toLaptop = pendingFrames(desktop.record).filter((p) => p.key === slot(3).key);
    expect(toLaptop.map((p) => p.d).sort()).toEqual([firstD!, record(0, "active").d!].sort());
    const oldest = toLaptop.find((p) => p.d === record(0, "active").d)!;
    expect(await deliver(laptop, oldest.frame)).toBe(true);
    expect(laptop.record).toMatchObject({ state: "standby", d: desktop.record.d, deviceSet: [slot(0), null, null, slot(3)] });
    // The phone, removed by the second move, is in no list.
    expect(pendingFrames(desktop.record).some((p) => p.key === slot(1).key)).toBe(false);
  });
});

describe("the tombstones' hourly put", () => {
  it("stops putting one where another valid tombstone stands, and says so", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active"));
    await moveSet(ports(desktop, network), { remove: slot(2).key });
    // A device that was left behind started a set of its own: its tombstone at the old address, listing only itself.
    const other = await signTombstone(oldKeys, 1, [null, { key: signers[1].publicKey, name: "Phone" }, null, null], sign(1));
    network.of(oldKeys.identity.pubKeyZ32).seed(other);
    const puts = await putTombstones(network, desktop.record, signers[0].publicKey);
    expect(puts).toEqual([{ d: record(0, "active").d, puts: [], foreign: true }]);
    const report = await resumeSetMove(ports(desktop, network));
    expect(report.record.earlierSets[0].foreign).toBe(true);
    expect(network.held(oldKeys)).toEqual(other);
    // Marked, it is skipped from then on.
    expect(await putTombstones(network, report.record, signers[0].publicKey)).toEqual([]);
  });

  it("puts nothing when no source answers, and the move stays stored for the next start", async () => {
    const { record } = await setOf(network);
    const desktop = memory(record(0, "active"));
    network.down = true;
    const report = await moveSet(ports(desktop, network), { remove: slot(2).key });
    expect(report.turnPut).toEqual([]);
    expect(report.tombstones[0].puts).toEqual([]);
    network.down = false;
    await resumeSetMove(ports(desktop, network));
    expect(opened(oldKeys, network.held(oldKeys)).tombstone).toBe(true);
  });
});

describe("the mark of a new address", () => {
  it("starts again with a new secret, and only rises otherwise", async () => {
    const { record } = await setOf(network);
    const active = record(0, "active");
    expect(() => amend(active, { seenSequence: 0 })).toThrow("may only rise");
    expect(amend(active, { seenSequence: 0, d: toBase64Url(label(0x77)), turnPacket: undefined }).seenSequence).toBe(0);
    expect(() => amend(active, { takeovers: -1 as never, d: toBase64Url(label(0x77)) })).toThrow();
  });
});
