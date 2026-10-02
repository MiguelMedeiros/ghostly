import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createIdentity, encodeTxtPacket, fromBase64Url, identityFromSeed, readTurnPacket, sign, signRelayPayload, signTurnPacket, signTurnRelease, toBase64Url, turnKeys,
  turnPayloadSequence, turnSequence, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_NO_ACTIVE, TURN_REV_LIMIT, type Identity, type TurnRecord, type TurnRelease,
} from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import { DEVICES_DB, closeDevicesDb, enrollDevice, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { TurnClosedError, TurnKeeper, type TurnStore } from "../src/devices/turn";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.turn.keeper

/*
 * The turn keeper against sources that behave as the DHT and a relay were measured to: what a device reads, what it
 * writes and puts, and which state it ends in. Devices are keepers with a store each; a clone is a second keeper on a
 * copy of one store.
 */

const D = new Uint8Array(32).fill(0xd0);
const keys = turnKeys(D);
const devices: Identity[] = [1, 2, 3, 4].map((n) => identityFromSeed(new Uint8Array(32).fill(n)));
const NAMES = ["Desktop", "Phone", "Laptop", "Tablet"];
const deviceSet = (held: number[]) => devices.map((device, i) => (held.includes(i) ? { key: toBase64Url(device.publicKey), name: NAMES[i] } : null));
const slots = (held: number[]) => devices.map((device, i) => (held.includes(i) ? { key: device.publicKey, name: NAMES[i] } : null));

/** A device state store in memory, with the real rules for a change (`state.ts`). */
function memoryStore(initial: DeviceRecord | null): TurnStore & { record: DeviceRecord | null; writes: DevicePatch[] } {
  const store = {
    record: initial, writes: [] as DevicePatch[],
    read: async () => store.record,
    amend: async (_profile: string, patch: DevicePatch) => { store.writes.push(patch); return (store.record = { ...amend(store.record!, patch), saved: store.record!.saved + 1 }); },
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => { store.writes.push({ ...patch }); return (store.record = { ...transition(store.record, profile, to, patch), saved: (store.record?.saved ?? 0) + 1 }); },
  };
  return store;
}

const recordOf = (own: number, state: "active" | "standby", turn: number, held = [0, 1, 2], patch: DevicePatch = {}): DeviceRecord =>
  firstRecord("ghostly", state, { turn, d: toBase64Url(D), deviceSet: deviceSet(held), ownSlot: own, ...patch });

function device(own: number, network: FakeTurnNetwork, record: DeviceRecord | null, extra: { instance?: number; undo?: () => Promise<void>; signer?: Identity; now?: () => number } = {}) {
  const store = memoryStore(record);
  const signer = extra.signer ?? devices[own];
  const keeper = new TurnKeeper({
    profile: "ghostly", network, store, signer: (bytes) => sign(bytes, signer.seed),
    ...(extra.instance !== undefined ? { instance: () => new Uint8Array(8).fill(extra.instance!) } : {}),
    ...(extra.undo ? { undoStaging: extra.undo } : {}), ...(extra.now ? { now: extra.now } : {}),
  });
  return { keeper, store };
}

/** A record as another device would put it. */
async function packet(turn: number, rev: number, author: number, options: { held?: number[]; release?: TurnRelease; instance?: number } = {}): Promise<Uint8Array> {
  return signTurnPacket(keys, { turn, rev, author, active: author, slots: slots(options.held ?? [0, 1, 2]), instance: new Uint8Array(8).fill(options.instance ?? 1), ...(options.release ? { release: options.release } : {}) }, (bytes) => sign(bytes, devices[author].seed));
}
const releaseTo = (turn: number, from: number, to: number) => signTurnRelease(keys.address, turn, from, to, devices[to].publicKey, new Uint8Array(32).fill(7), (bytes) => sign(bytes, devices[from].seed));
const tombstone = (author: number, held: number[]) => signTurnPacket(keys, { turn: TOMBSTONE_TURN, rev: 0, author, active: TURN_NO_ACTIVE, slots: slots(held), instance: new Uint8Array(8) }, (bytes) => sign(bytes, devices[author].seed));
const junk = (sequence: number | bigint) => signRelayPayload(keys.identity, encodeTxtPacket([{ name: `_s.${keys.identity.pubKeyZ32}`, value: "junk", ttl: 300 }]), BigInt(sequence));
const opened = (payload: Uint8Array | null | string | undefined): TurnRecord => {
  const read = readTurnPacket(keys, typeof payload === "string" ? fromBase64Url(payload) : payload!);
  if (read.kind !== "valid") throw new Error(`not a valid record: ${read.kind}`);
  return read.record;
};

/** An active device that already started once at `turn`: its record is stored and on every source. */
async function started(own: number, network: FakeTurnNetwork, turn: number, extra: Parameters<typeof device>[3] = {}) {
  const made = device(own, network, recordOf(own, "active", turn), extra);
  expect((await made.keeper.check(true)).kind).toBe("start");
  return made;
}

describe("a profile on one device", () => {
  it("has no turn: no source is read and nothing is put, whatever is asked", async () => {
    const network = new FakeTurnNetwork();
    const { keeper, store } = device(0, network, null);
    expect(await keeper.check(true)).toEqual({ kind: "single" });
    expect(await keeper.check(false)).toEqual({ kind: "single" });
    expect(await keeper.read()).toBeNull();
    expect(await keeper.putStored({ dht: null })).toBeNull();
    expect(await keeper.write({ dht: null })).toBeNull();
    expect(network.calls).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(keeper.goodWithin()).toBe(false);
  });

  it("the same with the real device state database, which a read does not even make", async () => {
    setDeviceMirror(null);
    await closeDevicesDb();
    await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICES_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    const network = new FakeTurnNetwork();
    const keeper = new TurnKeeper({ profile: "ghostly", network, signer: (bytes) => sign(bytes, devices[0].seed) });
    expect(await keeper.check(true)).toEqual({ kind: "single" });
    expect(network.calls).toEqual([]);
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
  });
});

describe("the active device", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("at start with no record anywhere: writes its record, stores it, then puts it with no condition, and starts", async () => {
    const { keeper, store } = device(0, network, recordOf(0, "active", 40), { instance: 5 });
    network.onPut = (payload) => { expect(store.record!.turnPacket, "stored before it is put").toBe(toBase64Url(payload)); };
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("start");
    expect(network.puts().map((p) => [p.source, p.condition])).toEqual([["dht", null], ["https://relay.test", null]]);
    const record = opened(network.source("dht").held);
    expect({ turn: record.turn, rev: record.rev, author: record.author, active: record.active, instance: [...record.instance] }).toEqual({ turn: 40, rev: 0, author: 0, active: 0, instance: Array(8).fill(5) });
    expect(store.record).toMatchObject({ state: "active", turn: 40, rev: 0, activeSlot: 0 });
    expect(keeper.goodWithin()).toBe(true);
  });

  it("at a restart: reads its own stored packet (mine), writes rev plus one with a new instance, conditional on what each source holds", async () => {
    const { keeper, store } = await started(0, network, 40);
    const first = network.source("dht").held!;
    network.calls.length = 0;
    expect((await keeper.check(true)).kind).toBe("start");
    const sequence = String(turnSequence(40, 0, 0));
    expect(network.puts().map((p) => [p.source, p.condition])).toEqual([["dht", sequence], ["https://relay.test", sequence]]);
    const next = opened(network.source("dht").held);
    expect(next.rev).toBe(1);
    expect([...next.instance]).not.toEqual([...opened(first).instance]);
    expect(store.record!.rev).toBe(1);
    expect(network.reads()).toBe(1);
  });

  it("puts its stored bytes unchanged, every time", async () => {
    const { keeper, store } = await started(0, network, 40);
    const stored = fromBase64Url(store.record!.turnPacket!);
    const read = (await keeper.read())!;
    expect(read.result).toBe("mine");
    const report = (await keeper.putStored(read.conditions))!;
    expect(report.payload).toEqual(stored);
    expect(report.puts.map((p) => p.outcome)).toEqual(["stored", "stored"]);
    expect(network.source("dht").held).toEqual(stored);
    // Running, with its record on the sources: it goes on, and puts nothing.
    network.calls.length = 0;
    expect(await keeper.check(false)).toMatchObject({ kind: "go-on", restricted: false });
    expect(network.puts()).toEqual([]);
  });

  it("superseded while it was off: it reads the higher turn at start and stops without publishing", async () => {
    const { keeper, store } = await started(0, network, 40);
    network.seed(await packet(41, 0, 1));
    network.calls.length = 0;
    const outcome = await keeper.check(true);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded", reload: false });
    expect(outcome.kind === "gated" && outcome.read.forced).toBe(true);
    expect(network.puts()).toEqual([]);
    expect(store.record!.state).toBe("superseded");
    // Its own record stays what it stored: the copy forked, and nothing of it changes.
    expect(opened(store.record!.turnPacket).turn).toBe(40);
  });

  it("superseded while it runs: written durably, then a reload into the gate", async () => {
    const { keeper, store } = await started(0, network, 40);
    network.seed(await packet(41, 0, 1, { release: await releaseTo(41, 0, 1) }), "https://relay.test");
    const outcome = await keeper.check(false);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded", reload: true });
    expect(outcome.kind === "gated" && outcome.read.forced).toBe(false);
    expect(store.record!.state).toBe("superseded");
  });

  it("a refused conditional put is never sent again without its condition: the refusal is answered with a read", async () => {
    const { keeper, store } = await started(0, network, 40);
    const theirs = await packet(41, 0, 1);
    // Another device takes the turn after this one's read and before its put.
    network.afterRead = () => { network.afterRead = undefined; network.seed(theirs); };
    network.calls.length = 0;
    const outcome = await keeper.check(true);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded" });
    const sequence = String(turnSequence(40, 0, 0));
    // One put to each source, with its condition, and no second one.
    expect(network.puts().map((p) => [p.source, p.condition])).toEqual([["dht", sequence], ["https://relay.test", sequence]]);
    expect(network.reads()).toBe(2);
    expect(network.source("dht").held).toBe(theirs);
    expect(network.source("https://relay.test").held).toBe(theirs);
    expect(store.record!.state).toBe("superseded");
  });

  it("the race a condition closes on the DHT: two devices write above one record, and the second learns at its put", async () => {
    // Device 0 is active and writes its next record; device 1 forces the same moment a takeover at the next turn,
    // conditional on the record both read. On the DHT the later put is refused (301); a relay ignores the condition.
    const a = await started(0, network, 40);
    const forced = await packet(41, 0, 1);
    network.source("dht").beforePut = () => { network.source("dht").beforePut = undefined; network.source("dht").held = forced; };
    network.calls.length = 0;
    const outcome = await a.keeper.check(true);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded" });
    expect(network.puts().filter((p) => p.source === "dht").length).toBe(1);
  });

  it("with no source reachable it does not start by itself: Try again, or Start anyway", async () => {
    let now = 1_000_000;
    const { keeper } = await started(0, network, 40, { now: () => now });
    for (const source of network.sources) source.down = true;
    now += 120_000;
    network.calls.length = 0;
    expect((await keeper.check(true)).kind).toBe("ask");
    expect(network.puts()).toEqual([]);
    expect(keeper.goodWithin(60_000)).toBe(false);
    // Running, it goes on, restricted until a good read: no wallet opened, no spend, no admin work.
    expect(await keeper.check(false)).toMatchObject({ kind: "go-on", restricted: true });
    network.source("dht").down = false;
    expect(await keeper.check(false)).toMatchObject({ kind: "go-on", restricted: false });
    expect(keeper.goodWithin(60_000)).toBe(true);
    now += 61_000;
    expect(keeper.goodWithin(60_000)).toBe(false);
  });

  it("the record expired while it ran: it puts its stored packet again, unchanged, and goes on", async () => {
    const { keeper, store } = await started(0, network, 40);
    const stored = fromBase64Url(store.record!.turnPacket!);
    network.seed(null);
    network.calls.length = 0;
    expect(await keeper.check(false)).toMatchObject({ kind: "go-on", restricted: false });
    expect(network.puts().map((p) => [p.source, p.condition])).toEqual([["dht", null], ["https://relay.test", null]]);
    expect(network.source("dht").held).toEqual(stored);
  });

  it("behind: sources hold its earlier record; it puts the stored packet again on what it read, and reads until one returns it", async () => {
    const { keeper, store } = await started(0, network, 40);
    const earlier = network.source("dht").held!;
    expect((await keeper.check(true)).kind).toBe("start");
    const stored = fromBase64Url(store.record!.turnPacket!);
    // The sources forgot the newer record.
    network.seed(earlier);
    network.calls.length = 0;
    expect(await keeper.check(false)).toMatchObject({ kind: "go-on", restricted: false });
    expect(network.puts().map((p) => p.condition)).toEqual([String(turnSequence(40, 0, 0)), String(turnSequence(40, 0, 0))]);
    expect(network.puts().every((p) => p.payload === undefined || toBase64Url(p.payload) === toBase64Url(stored))).toBe(true);
    expect(network.reads()).toBe(2);
    expect(network.source("dht").held).toEqual(stored);
  });

  it("behind ends after three rounds: an active device then puts with no condition, as on none", async () => {
    const { keeper, store } = await started(0, network, 40);
    const earlier = network.source("dht").held!;
    expect((await keeper.check(true)).kind).toBe("start");
    network.seed(earlier);
    // Sources that take every put and keep answering the older record.
    for (const source of network.sources) source.frozen = true;
    network.calls.length = 0;
    const outcome = await keeper.check(false);
    expect(outcome).toMatchObject({ kind: "go-on", restricted: false });
    const dhtPuts = network.puts().filter((p) => p.source === "dht");
    const conditional = String(turnSequence(40, 0, 0));
    expect(dhtPuts.map((p) => p.condition)).toEqual([conditional, conditional, conditional, null]);
    expect(network.reads()).toBe(4);
    expect(store.record!.state).toBe("active");
  });

  it("an invalid record with a high rev does not block its next put: it writes above the highest raw sequence it ever saw", async () => {
    const { keeper, store } = await started(0, network, 40);
    const high = turnSequence(40, 5000, 3);
    network.seed(junk(high));
    network.calls.length = 0;
    const outcome = await keeper.check(false);
    expect(outcome).toMatchObject({ kind: "go-on" });
    expect(outcome.kind === "go-on" && outcome.read.invalid.length).toBe(2);
    const record = opened(network.source("dht").held);
    expect(record.turn).toBe(40);
    expect(record.sequence).toBeGreaterThan(high);
    expect(record.sequence - high).toBeLessThanOrEqual(4);
    // Conditional on that raw sequence, on each source.
    expect(network.puts().map((p) => p.condition)).toEqual([String(high), String(high)]);
    expect(store.record!.seenSequence).toBe(high);
    // The raw sequence is remembered: with the junk gone, the next record is still above it.
    network.seed(null);
    expect((await keeper.check(true)).kind).toBe("start");
    expect(opened(network.source("dht").held).sequence).toBeGreaterThan(high);
  });

  it("a slot added by a holder of D under its turn is invalid: it keeps its turn and writes above it", async () => {
    const { keeper } = await started(0, network, 40);
    // Device 1 writes a record in turn 40 that names device 0 active: not written by the device it names active.
    const unsigned = await packet(40, 9, 1, { held: [0, 1, 2, 3] });
    const body = opened(unsigned).body.slice();
    body[9] = 0;
    const { turnSignedMessage, concatBytes, sealTurnBody } = await import("@ghostly/core");
    const forged = concatBytes(body.subarray(0, 310), sign(turnSignedMessage(keys.address, body), devices[1].seed));
    const sneaked = signRelayPayload(keys.identity, encodeTxtPacket([{ name: `_s.${keys.identity.pubKeyZ32}`, value: sealTurnBody(forged, keys.sealKey), ttl: 300 }]), BigInt(turnSequence(40, 9, 1)));
    expect(readTurnPacket(keys, sneaked)).toMatchObject({ kind: "invalid", refusal: "author-not-active" });
    network.seed(sneaked);
    const outcome = await keeper.check(false);
    expect(outcome).toMatchObject({ kind: "go-on" });
    const record = opened(network.source("dht").held);
    expect(record.author).toBe(0);
    expect(record.sequence).toBeGreaterThan(turnSequence(40, 9, 1));
    expect(record.slots.filter(Boolean).length).toBe(3);
  });

  it("when rev runs out it writes the next turn, with a release from itself to itself, and stays active", async () => {
    const stored = await packet(40, TURN_REV_LIMIT - 1, 0);
    network.seed(stored);
    const { keeper, store } = device(0, network, recordOf(0, "active", 40, [0, 1, 2], { rev: TURN_REV_LIMIT - 1, turnPacket: toBase64Url(stored), activeSlot: 0 }));
    expect((await keeper.check(true)).kind).toBe("start");
    const record = opened(network.source("dht").held);
    expect({ turn: record.turn, rev: record.rev, from: record.release?.from, to: record.release?.to }).toEqual({ turn: 41, rev: 0, from: 0, to: 0 });
    expect(store.record).toMatchObject({ state: "active", turn: 41, rev: 0 });
    // The next record of that turn still carries how the turn was taken.
    expect((await keeper.check(true)).kind).toBe("start");
    expect(opened(network.source("dht").held)).toMatchObject({ turn: 41, rev: 1, release: { from: 0, to: 0 } });
  });

  it("a tombstone sends it to moving while it is listed, and to removed when it is not; nothing is put", async () => {
    const listed = await started(0, network, 40);
    network.seed(await tombstone(1, [0, 1]));
    network.calls.length = 0;
    expect(await listed.keeper.check(false)).toMatchObject({ kind: "gated", state: "moving", reload: true });
    const other = new FakeTurnNetwork();
    const gone = await started(0, other, 40);
    other.seed(await tombstone(1, [1, 2]));
    expect(await gone.keeper.check(true)).toMatchObject({ kind: "gated", state: "removed", reload: false });
    expect(network.puts()).toEqual([]);
    expect(gone.store.record!.seenSequence).toBe(TOMBSTONE_SEQUENCE);
  });

  it("an address closed by something that is no tombstone takes no further record, and it says so", async () => {
    const { keeper } = await started(0, network, 40);
    network.seed(junk(TOMBSTONE_SEQUENCE));
    network.calls.length = 0;
    expect((await keeper.check(true)).kind).toBe("closed");
    expect(network.puts()).toEqual([]);
    const read = (await keeper.read())!;
    await expect(keeper.write(read.conditions)).rejects.toThrow(TurnClosedError);
  });
});

describe("cloned storage", () => {
  it("the copy that started last goes on; the one that did not write the newest record stops at its next read", async () => {
    const network = new FakeTurnNetwork();
    const original = await started(0, network, 40);
    // The storage is copied (a disk image, a browser profile folder), and the copy starts.
    const copy = device(0, network, structuredClone(original.store.record));
    expect((await copy.keeper.check(true)).kind).toBe("start");
    // The original has run since before the copy was made: its next read finds a record from its own slot it never stored.
    const outcome = await original.keeper.check(false);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded", reload: true, notice: "another-copy" });
    expect(outcome.kind === "gated" && outcome.read.clone).toBe("above");
    expect(await copy.keeper.check(false)).toMatchObject({ kind: "go-on" });
  });

  /** Two copies of one storage that both read `mine` and each wrote rev 1 with its own instance. `kept`: whose record the source ended with. */
  async function twins(kept: "low" | "high") {
    const network = new FakeTurnNetwork([{ name: "source", kind: "dht" }]);
    const first = await started(0, network, 40);
    const snapshot = structuredClone(first.store.record);
    const low = device(0, network, structuredClone(snapshot), { instance: 1 }), high = device(0, network, structuredClone(snapshot), { instance: 2 });
    const lowRead = (await low.keeper.read())!, highRead = (await high.keeper.read())!;
    expect([lowRead.result, highRead.result]).toEqual(["mine", "mine"]);
    const [winner, loser, winnerRead, loserRead] = kept === "low" ? [low, high, lowRead, highRead] : [high, low, highRead, lowRead];
    const stored = (await winner.keeper.write(winnerRead.conditions))!, refused = (await loser.keeper.write(loserRead.conditions))!;
    expect(turnPayloadSequence(stored.payload)).toBe(turnPayloadSequence(refused.payload));
    // The second put's condition names the record both read, which the first put replaced: refused, and not sent again.
    expect([stored.refused, refused.refused]).toEqual([false, true]);
    expect(network.source("source").held).toBe(stored.payload);
    return { network, low, high };
  }

  it("both copies start in the same moment and the source keeps the lower instance's record: that copy goes on, the other stops", async () => {
    const { network, low, high } = await twins("low");
    const outcome = await high.keeper.check(false);
    expect(outcome).toMatchObject({ kind: "gated", state: "superseded", notice: "another-copy" });
    expect(outcome.kind === "gated" && outcome.read).toMatchObject({ clone: "equal", lower: false });
    expect(await low.keeper.check(false)).toMatchObject({ kind: "go-on" });
    expect(opened(network.source("source").held)).toMatchObject({ rev: 1 });
    // Only the very first put of the device set went out with no condition.
    expect(network.puts().filter((p) => p.condition === null).length).toBe(1);
  });

  it("the source keeps the higher instance's record: the lower instance writes rev plus one at once, and the other stops at its next read", async () => {
    const { network, low, high } = await twins("high");
    // The copy with the higher instance reads its own record: it does not know yet.
    expect(await high.keeper.check(false)).toMatchObject({ kind: "go-on" });
    const outcome = await low.keeper.check(false);
    expect(outcome).toMatchObject({ kind: "go-on" });
    expect(outcome.kind === "go-on" && outcome.read).toMatchObject({ result: "clone", clone: "equal", lower: true });
    // The network holds one record again: the lower instance's, at rev 2.
    const held = opened(network.source("source").held);
    expect({ rev: held.rev, instance: [...held.instance] }).toEqual({ rev: 2, instance: Array(8).fill(1) });
    expect(low.store.record).toMatchObject({ state: "active", rev: 2 });
    const stop = await high.keeper.check(false);
    expect(stop).toMatchObject({ kind: "gated", state: "superseded", reload: true, notice: "another-copy" });
    expect(stop.kind === "gated" && stop.read.clone).toBe("above");
    expect(await low.keeper.check(false)).toMatchObject({ kind: "go-on" });
  });

  it("a relay keeps the larger encoded bytes of two packets at one sequence, which is random: the rule still gives one copy", async () => {
    const network = new FakeTurnNetwork([{ name: "relay", kind: "relay" }]);
    const first = await started(0, network, 40);
    const snapshot = structuredClone(first.store.record);
    const low = device(0, network, structuredClone(snapshot), { instance: 1 }), high = device(0, network, structuredClone(snapshot), { instance: 2 });
    const lowRead = (await low.keeper.read())!, highRead = (await high.keeper.read())!;
    await low.keeper.write(lowRead.conditions);
    await high.keeper.write(highRead.conditions);
    // Whichever packet the relay kept, and whoever reads first, a few reads later exactly one copy runs: the lower instance.
    for (let i = 0; i < 3; i++) { await high.keeper.check(false).catch(() => {}); await low.keeper.check(false); }
    expect(low.store.record!.state).toBe("active");
    expect(high.store.record!.state).toBe("superseded");
    expect([...opened(network.source("relay").held).instance]).toEqual(Array(8).fill(1));
  });

  it("two restored copies that took the same free slot with different keys settle the same way", async () => {
    const network = new FakeTurnNetwork([{ name: "source", kind: "dht" }]);
    const one = createIdentity(), two = createIdentity();
    const setWith = (key: Identity) => [...deviceSet([0, 1, 2]).slice(0, 3), { key: toBase64Url(key.publicKey), name: "Restored" }];
    const a = device(3, network, recordOf(3, "active", 41, [0, 1, 2], { deviceSet: setWith(one) }), { signer: one, instance: 1 });
    const b = device(3, network, recordOf(3, "active", 41, [0, 1, 2], { deviceSet: setWith(two) }), { signer: two, instance: 2 });
    // Both found no record and put with no condition: the DHT takes the second packet at the equal sequence.
    await a.keeper.write({ source: null });
    await b.keeper.write({ source: null });
    const outcome = await a.keeper.check(false);
    expect(outcome.kind === "go-on" && outcome.read).toMatchObject({ result: "clone", clone: "equal", lower: true });
    expect(await b.keeper.check(false)).toMatchObject({ kind: "gated", state: "superseded", notice: "another-copy" });
    expect(await a.keeper.check(false)).toMatchObject({ kind: "go-on" });
  });
});

describe("a standby", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("shows the active device, keeps the record it accepted, and never puts", async () => {
    const active = await packet(40, 2, 0);
    network.seed(active);
    const { keeper, store } = device(1, network, recordOf(1, "standby", 39));
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "active-on", device: "Desktop" });
    expect(store.record).toMatchObject({ state: "standby", turn: 40, rev: 2, activeSlot: 0, turnPacket: toBase64Url(active) });
    // Read again, the record is the one it knows: nothing is written.
    const writes = store.writes.length;
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "active-on", device: "Desktop" });
    expect(store.writes.length).toBe(writes);
    // A takeover by another device is shown as one.
    network.seed(await packet(41, 0, 2));
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "active-on", device: "Laptop", forced: true });
    expect(network.puts()).toEqual([]);
  });

  it("with no record on the sources it shows the device it last knew, and with no source it says it cannot check", async () => {
    const active = await packet(40, 2, 0);
    const { keeper } = device(1, network, recordOf(1, "standby", 40, [0, 1, 2], { rev: 2, turnPacket: toBase64Url(active), activeSlot: 0 }));
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "last-known", device: "Desktop" });
    // The sources hold something older than what it knows: the same.
    network.seed(await packet(40, 1, 0));
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "last-known", device: "Desktop" });
    for (const source of network.sources) source.down = true;
    const outcome = await keeper.check(true);
    expect(outcome).toMatchObject({ kind: "show", screen: "cannot-check" });
    expect(outcome.kind === "show" && outcome.device).toBeUndefined();
    expect(network.puts()).toEqual([]);
  });

  it("that released the turn and still reads its own record: the turn is moving to the device it released to", async () => {
    const mine = await packet(40, 2, 1);
    network.seed(mine);
    const release = await releaseTo(41, 1, 0);
    const { keeper } = device(1, network, recordOf(1, "standby", 40, [0, 1, 2], {
      rev: 2, turnPacket: toBase64Url(mine), activeSlot: 1, releasedTurn: 41,
      handoff: { role: "releasing", step: "released", release: { turn: 41, to: toBase64Url(devices[0].publicKey), h: toBase64Url(release.h), s: toBase64Url(release.signature) } },
    }));
    expect(await keeper.check(true)).toMatchObject({ kind: "show", screen: "moving-to", device: "Desktop" });
    expect(network.puts()).toEqual([]);
  });

  it("reads a tombstone: moving while listed, removed when not", async () => {
    network.seed(await tombstone(0, [0, 1]));
    const listed = device(1, network, recordOf(1, "standby", 40));
    expect(await listed.keeper.check(true)).toMatchObject({ kind: "gated", state: "moving" });
    const gone = device(2, network, recordOf(2, "standby", 40));
    expect(await gone.keeper.check(true)).toMatchObject({ kind: "gated", state: "removed" });
    // Moving, it waits for the set-update; removed, it stays, and may be added again.
    expect(await listed.keeper.check(true)).toMatchObject({ kind: "stay", awaits: "set-update" });
    expect(await gone.keeper.check(true)).toMatchObject({ kind: "stay", offers: ["add-again"] });
  });
});

describe("a taking device", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  /** Device 1 holds device 0's release of turn 41, stored its own record of that turn, and has put it or not. */
  async function taker(put: boolean, undo = async () => {}) {
    network.seed(await packet(40, 3, 0));
    const made = device(1, network, { ...recordOf(1, "standby", 40), state: "taking" }, { undo });
    const read = (await made.keeper.read())!;
    const report = (await made.keeper.write(put ? read.conditions : {}, { turn: 41, release: await releaseTo(41, 0, 1) }))!;
    return { ...made, report };
  }

  it("sees its own turn accepted and read back: only then is it active, and the engine starts", async () => {
    const { keeper, store, report } = await taker(true);
    expect(report.puts.map((p) => p.outcome)).toEqual(["stored", "stored"]);
    expect(store.record!.state).toBe("taking");
    expect((await keeper.check(true)).kind).toBe("start");
    expect(store.record).toMatchObject({ state: "active", turn: 41, rev: 0 });
    expect(opened(network.source("dht").held)).toMatchObject({ turn: 41, author: 1, release: { from: 0, to: 1 } });
  });

  it("yields to a third device that forced the same turn, in either slot order: the staged state is dropped before standby is written", async () => {
    for (const forcing of [0, 2]) {
      network = new FakeTurnNetwork();
      const order: string[] = [];
      const made = await taker(true, async () => { order.push(`undo while ${made.store.record!.state}`); });
      network.seed(await packet(41, 0, forcing), "https://relay.test");
      const outcome = await made.keeper.check(true);
      expect(outcome, `forced from slot ${forcing}`).toMatchObject({ kind: "gated", state: "standby" });
      expect(order).toEqual(["undo while taking"]);
      expect(made.store.record!.state).toBe("standby");
    }
  });

  it("with no record on the sources it puts with no condition and reads back", async () => {
    const { keeper, store } = await taker(false);
    network.seed(null);
    network.calls.length = 0;
    expect((await keeper.check(true)).kind).toBe("start");
    expect(network.puts().map((p) => p.condition)).toEqual([null, null]);
    expect(store.record!.state).toBe("active");
  });

  it("behind for three rounds, it waits and tries later; with no source, it waits", async () => {
    const { keeper, store } = await taker(false);
    for (const source of network.sources) source.frozen = true;
    network.calls.length = 0;
    expect((await keeper.check(true)).kind).toBe("wait");
    expect(network.puts().filter((p) => p.source === "dht").length).toBe(3);
    expect(store.record!.state).toBe("taking");
    for (const source of network.sources) source.down = true;
    expect((await keeper.check(true)).kind).toBe("wait");
  });

  it("a tombstone ends the taking: staging undone, standby, then moving or removed", async () => {
    let undone = 0;
    const { keeper, store } = await taker(true, async () => { undone++; });
    network.seed(await tombstone(0, [0, 2]));
    expect(await keeper.check(true)).toMatchObject({ kind: "gated", state: "removed" });
    expect(undone).toBe(1);
    expect(store.record!.state).toBe("removed");
  });

  it("without a way to undo its staged state it does not step back", async () => {
    network.seed(await packet(40, 3, 0));
    const made = device(1, network, { ...recordOf(1, "standby", 40), state: "taking" });
    await made.keeper.write({}, { turn: 41, release: await releaseTo(41, 0, 1) });
    network.seed(await packet(41, 0, 2));
    await expect(made.keeper.check(true)).rejects.toThrow("staged state");
    expect(made.store.record!.state).toBe("taking");
  });
});

describe("the other states", () => {
  it("a releasing device at start is active again, and reads as one that starts", async () => {
    const network = new FakeTurnNetwork();
    const first = await started(0, network, 40);
    const releasing = device(0, network, { ...structuredClone(first.store.record!), state: "releasing" });
    expect((await releasing.keeper.check(true)).kind).toBe("start");
    expect(releasing.store.record).toMatchObject({ state: "active", rev: 1 });
    // With no source reachable: active, and not started by itself.
    const again = device(0, network, { ...structuredClone(releasing.store.record!), state: "releasing" });
    for (const source of network.sources) source.down = true;
    expect((await again.keeper.check(true)).kind).toBe("ask");
    expect(again.store.record!.state).toBe("active");
  });

  it("a superseded device stays, with Use here and It wasn't me; a record of its own on the sources cannot be", async () => {
    const network = new FakeTurnNetwork();
    const first = await started(0, network, 40);
    const superseded = device(0, network, { ...structuredClone(first.store.record!), state: "superseded" });
    expect((await superseded.keeper.check(true)).kind).toBe("impossible");
    network.seed(await packet(41, 0, 1));
    expect(await superseded.keeper.check(true)).toMatchObject({ kind: "stay", offers: ["use-here", "it-wasnt-me"] });
    expect(network.puts().length).toBe(2);
    expect(superseded.store.record!.state).toBe("superseded");
  });

  it("the real device state database: a start writes the record durably and the next start finds it", async () => {
    setDeviceMirror(null);
    await closeDevicesDb();
    await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICES_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    await enrollDevice("ghostly", "active", { turn: 40, d: toBase64Url(D), deviceSet: deviceSet([0, 1]), ownSlot: 0 });
    const network = new FakeTurnNetwork();
    const keeper = new TurnKeeper({ profile: "ghostly", network, signer: (bytes) => sign(bytes, devices[0].seed) });
    expect((await keeper.check(true)).kind).toBe("start");
    const stored = await readDeviceRecord("ghostly");
    expect(stored).toMatchObject({ state: "active", turn: 40, rev: 0, activeSlot: 0 });
    expect(fromBase64Url(stored!.turnPacket!)).toEqual(network.source("dht").held);
    network.seed(await packet(41, 0, 1, { held: [0, 1] }));
    expect(await new TurnKeeper({ profile: "ghostly", network, signer: (bytes) => sign(bytes, devices[0].seed) }).check(true)).toMatchObject({ kind: "gated", state: "superseded" });
    expect((await readDeviceRecord("ghostly"))!.state).toBe("superseded");
  });
});
