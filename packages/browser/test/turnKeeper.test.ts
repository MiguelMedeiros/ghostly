import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createIdentity, encodeTxtPacket, fromBase64Url, identityFromSeed, readTurnPacket, sign, signRelayPayload, signTurnPacket, signTurnRelease, toBase64Url, turnKeys,
  turnPayloadSequence, turnSequence, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_NO_ACTIVE, TURN_REV_LIMIT, type Identity, type TurnRecord, type TurnRelease,
} from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import { DEVICES_DB, closeDevicesDb, enrollDevice, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { TURN_RAISE_WINDOW_MS, TURN_SETTLE_MARGIN_MS, TurnClosedError, TurnKeeper, TurnStaleReadError, type TurnStore } from "../src/devices/turn";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import type { TurnNetwork } from "@ghostly/core";
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

/** The tests' clock: a wait moves it, and nothing sleeps for real. `onSleep` is where the other devices act meanwhile. */
const clock = { t: 1_000_000, slept: [] as number[], onSleep: undefined as (() => Promise<void>) | undefined };
beforeEach(() => { clock.t = 1_000_000; clock.slept = []; clock.onSleep = undefined; });

function device(own: number, network: TurnNetwork, record: DeviceRecord | null, extra: { instance?: number; undo?: () => Promise<void>; signer?: Identity; now?: () => number } = {}) {
  const store = memoryStore(record);
  const signer = extra.signer ?? devices[own];
  const keeper = new TurnKeeper({
    profile: "ghostly", network, store, signer: (bytes) => sign(bytes, signer.seed),
    ...(extra.instance !== undefined ? { instance: () => new Uint8Array(8).fill(extra.instance!) } : {}),
    ...(extra.undo ? { undoStaging: extra.undo } : {}), now: extra.now ?? (() => clock.t),
    sleep: async (ms) => { clock.slept.push(ms); await clock.onSleep?.(); clock.t += ms; },
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
    // It starts only once a source returned the record it wrote: a read before, and a read back.
    expect(network.reads()).toBe(2);
  });

  it("does not start on a record no source took: every put failed, so it asks", async () => {
    const { keeper, store } = device(0, network, recordOf(0, "active", 40));
    for (const source of network.sources) source.putFails = true;
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("ask");
    // The record is written and stored, put again a few times, and no source holds it.
    expect(store.record).toMatchObject({ state: "active", turn: 40, rev: 0 });
    expect(network.puts().filter((p) => p.source === "dht").length).toBe(4);
    expect(new Set(network.puts().map((p) => toBase64Url(p.payload!))).size).toBe(1);
    expect(network.sources.every((source) => source.held === null)).toBe(true);
    // One source takes it: the same record, and it starts.
    network.source("dht").putFails = false;
    expect((await keeper.check(true)).kind).toBe("start");
  });

  it("on none at start it reads its record back before it starts", async () => {
    const { keeper } = device(0, network, recordOf(0, "active", 40));
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("start");
    expect(outcome.kind === "start" && outcome.read.result).toBe("mine");
    expect(network.reads()).toBe(2);
  });

  it("a number a relay names without a signed packet cannot close the address: the device starts, and nothing is remembered", async () => {
    const { keeper, store } = await started(0, network, 40);
    // The relay's 404 header claims the DHT holds an item at the tombstone's sequence. Nobody signed that.
    network.source("https://relay.test").held = null;
    network.source("https://relay.test").sequences = [String(TOMBSTONE_SEQUENCE)];
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("start");
    expect(outcome.kind === "start" && outcome.read.closed).toBe(false);
    expect(store.record!.seenSequence).toBe(turnSequence(40, 1, 0));
    expect(store.record).toMatchObject({ turn: 40, rev: 1 });
    // The header gone, every later start works: nothing was stored of it.
    network.source("https://relay.test").sequences = undefined;
    expect((await keeper.check(true)).kind).toBe("start");
    const read = (await keeper.read())!;
    await expect(keeper.write(read.conditions)).resolves.toBeTruthy();
  });

  it("a number a relay names at a later turn does not make the device raise the turn", async () => {
    const { keeper, store } = await started(0, network, 40);
    network.source("https://relay.test").held = null;
    network.source("https://relay.test").sequences = [String(turnSequence(45, 0, 0))];
    expect((await keeper.check(true)).kind).toBe("start");
    const record = opened(network.source("dht").held);
    expect({ turn: record.turn, rev: record.rev, release: record.release }).toEqual({ turn: 40, rev: 1, release: undefined });
    expect(store.record!.turn).toBe(40);
    expect(store.record!.seenSequence).toBeLessThan(turnSequence(41, 0, 0));
    // It is that relay's put condition, and nothing else.
    expect(network.puts().filter((p) => p.source === "https://relay.test").at(-1)!.condition).toBe(String(turnSequence(45, 0, 0)));
  });

  it("a stale relay answer alone does not let it start; with a fresh source it does", async () => {
    const { keeper } = await started(0, network, 40);
    network.source("https://relay.test").stale = true;
    clock.t += 1_000;
    network.source("dht").down = true;
    expect((await keeper.check(true)).kind).toBe("ask");
    expect(keeper.goodWithin(500)).toBe(false);
    network.source("dht").down = false;
    expect((await keeper.check(true)).kind).toBe("start");
  });

  it("tells the sources to get ready once it has a device set, and never for a profile on one device", async () => {
    const single = device(0, network, null);
    await single.keeper.check(true);
    expect(network.warmed).toBe(0);
    const { keeper } = device(0, network, recordOf(0, "active", 40));
    await keeper.check(true);
    await keeper.check(false);
    expect(network.warmed).toBe(1);
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

  it("a source that refuses what another took does not make it write again and again: one record, and it starts", async () => {
    const { keeper, store } = await started(0, network, 40);
    // The relay refuses the put (409) while the DHT takes it and returns it: the refusal is answered with a read,
    // the read says `mine`, and that is the end of it.
    network.source("https://relay.test").refuses = true;
    network.calls.length = 0;
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("start");
    expect(store.record!.rev).toBe(1);
    expect(network.puts().map((p) => p.source)).toEqual(["dht", "https://relay.test"]);
    expect(network.reads()).toBe(2);
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
    expect((await keeper.read())!.invalid.length).toBe(2);
    network.calls.length = 0;
    const outcome = await keeper.check(false);
    expect(outcome).toMatchObject({ kind: "go-on" });
    const record = opened(network.source("dht").held);
    expect(record.turn).toBe(40);
    expect(record.sequence).toBeGreaterThan(high);
    expect(record.sequence - high).toBeLessThanOrEqual(4);
    // Conditional on that raw sequence, on each source.
    expect(network.puts().map((p) => p.condition)).toEqual([String(high), String(high)]);
    expect(store.record!.seenSequence).toBeGreaterThanOrEqual(high);
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
    expect((await low.keeper.read())!).toMatchObject({ result: "clone", clone: "equal", lower: true });
    expect(await low.keeper.check(false)).toMatchObject({ kind: "go-on" });
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
    expect((await a.keeper.read())!).toMatchObject({ result: "clone", clone: "equal", lower: true });
    expect(await a.keeper.check(false)).toMatchObject({ kind: "go-on" });
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
    await made.keeper.read();
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

  it("a superseded device stays, with Use here and It wasn't me, also when the record that replaced it expired and its own is read again", async () => {
    const network = new FakeTurnNetwork();
    const first = await started(0, network, 40);
    const superseded = device(0, network, { ...structuredClone(first.store.record!), state: "superseded" });
    const own = await superseded.keeper.check(true);
    expect(own).toMatchObject({ kind: "stay", offers: ["use-here", "it-wasnt-me"] });
    expect(own.kind === "stay" && own.read.result).toBe("mine");
    network.seed(await packet(41, 0, 1));
    expect(await superseded.keeper.check(true)).toMatchObject({ kind: "stay", offers: ["use-here", "it-wasnt-me"] });
    // Only the first start ever put anything.
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

describe("raising the turn where relays ignore the condition", () => {
  const SETTLE = TURN_RAISE_WINDOW_MS + TURN_SETTLE_MARGIN_MS;
  const takingRecord = (own: number) => ({ ...recordOf(own, "standby", 40), state: "taking" as const });

  it("a taker is active only after a read made more than T after its put", async () => {
    const network = new FakeTurnNetwork([{ name: "https://relay.test", kind: "relay" }]);
    network.seed(await packet(40, 3, 0));
    const taker = device(1, network, takingRecord(1), { undo: async () => {} });
    const read = (await taker.keeper.read())!;
    clock.t += 2_000;
    await taker.keeper.write(read.conditions, { turn: 41, release: await releaseTo(41, 0, 1) });
    clock.t += 500;
    network.calls.length = 0;
    expect((await taker.keeper.check(true)).kind).toBe("start");
    // Its own record read back at once is not enough: it waits out the rest of T and a margin, and reads again.
    expect(clock.slept).toEqual([SETTLE - 500]);
    expect(network.reads()).toBe(2);
    expect(taker.store.record!.state).toBe("active");
    expect(TURN_RAISE_WINDOW_MS).toBe(20_000);
  });

  it("the race the condition does not close on relays: the lower slot puts first, the higher second, both read their own back; only one is active", async () => {
    const network = new FakeTurnNetwork([{ name: "https://relay.test", kind: "relay" }]);
    network.seed(await packet(40, 3, 0));
    const low = device(1, network, takingRecord(1), { undo: async () => {} });
    const high = device(2, network, takingRecord(2), { undo: async () => {} });
    const lowRead = (await low.keeper.read())!, highRead = (await high.keeper.read())!;
    await low.keeper.write(lowRead.conditions, { turn: 41, release: await releaseTo(41, 0, 1) });
    // Read at once, the lower slot's own record is the highest: without the wait it would start here.
    expect((await low.keeper.read())!.result).toBe("mine");
    // The other device read the old record too, and puts inside its window: the relay takes it, whatever `If-Match` says.
    clock.t += TURN_RAISE_WINDOW_MS - 8_000;
    const second = (await high.keeper.write(highRead.conditions, { turn: 41 }))!;
    expect(second.puts.map((p) => p.outcome)).toEqual(["stored"]);
    expect((await high.keeper.read())!.result).toBe("mine");
    // Each waits longer than T after its own put and reads again.
    expect(await low.keeper.check(true)).toMatchObject({ kind: "gated", state: "standby" });
    expect((await high.keeper.check(true)).kind).toBe("start");
    expect([low.store.record!.state, high.store.record!.state]).toEqual(["standby", "active"]);
  });

  it("a put that would end later than T after its read is not begun: the device reads again", async () => {
    const network = new FakeTurnNetwork([{ name: "https://relay.test", kind: "relay" }]);
    network.seed(await packet(40, 3, 0));
    const taker = device(1, network, takingRecord(1));
    const read = (await taker.keeper.read())!;
    clock.t += TURN_RAISE_WINDOW_MS - 8_000 + 1;
    network.calls.length = 0;
    await expect(taker.keeper.write(read.conditions, { turn: 41, release: await releaseTo(41, 0, 1) })).rejects.toThrow(TurnStaleReadError);
    // Nothing was signed, stored or put.
    expect(network.puts()).toEqual([]);
    expect(taker.store.record!.turnPacket).toBeUndefined();
    // With no read at all, the same.
    const blind = device(2, network, takingRecord(2));
    await expect(blind.keeper.write({}, { turn: 41 })).rejects.toThrow(TurnStaleReadError);
    // After a fresh read it goes through.
    const again = (await taker.keeper.read())!;
    expect((await taker.keeper.write(again.conditions, { turn: 41, release: await releaseTo(41, 0, 1) }))!.puts[0].outcome).toBe("stored");
  });

  it("a taker that restarted does not know when it put: it waits the whole of T from its first read", async () => {
    const network = new FakeTurnNetwork([{ name: "https://relay.test", kind: "relay" }]);
    network.seed(await packet(40, 3, 0));
    const first = device(1, network, takingRecord(1));
    const read = (await first.keeper.read())!;
    await first.keeper.write(read.conditions, { turn: 41, release: await releaseTo(41, 0, 1) });
    // The app is closed and opened again: a new keeper on the stored state.
    const again = device(1, network, structuredClone(first.store.record), { undo: async () => {} });
    expect((await again.keeper.check(true)).kind).toBe("start");
    expect(clock.slept).toEqual([SETTLE]);
  });

  it("a forced takeover goes the same way: read, put within T, wait, read every source again", async () => {
    const network = new FakeTurnNetwork();
    network.seed(await packet(40, 3, 0));
    const forcing = device(2, network, recordOf(2, "standby", 40, [0, 1, 2], { turnPacket: toBase64Url(await packet(40, 3, 0)), rev: 3, activeSlot: 0 }));
    network.calls.length = 0;
    const raised = (await forcing.keeper.raise({ turn: 41 }))!;
    expect(raised.mine).toBe(true);
    expect(clock.slept).toEqual([SETTLE]);
    expect(network.reads()).toBe(2);
    expect(opened(network.source("dht").held)).toMatchObject({ turn: 41, author: 2 });
    expect(opened(network.source("dht").held).release).toBeUndefined();
    // The state is the host's to change: the keeper only says whether the device may.
    expect(forcing.store.record!.state).toBe("standby");
    // With no source reachable nothing is written.
    const blind = device(1, network, recordOf(1, "standby", 40));
    for (const source of network.sources) source.down = true;
    network.calls.length = 0;
    expect(await blind.keeper.raise({ turn: 41 })).toMatchObject({ mine: false, report: null });
    expect(network.puts()).toEqual([]);
    // And a profile on one device has no turn to raise.
    expect(await device(0, network, null).keeper.raise({ turn: 41 })).toBeNull();
  });

  /** All orders of `items`. */
  const orders = <T,>(items: T[]): T[][] => (items.length < 2 ? [items] : items.flatMap((item, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

  /**
   * Devices that all read the same record (turn 40, device 0 active), then each put turn 41 in `order`, then each
   * make the read that decides. A taker (it holds device 0's release) and devices that force the turn. Returns the
   * slots that ended active.
   */
  async function race(slotsRacing: number[], takerSlot: number | null, order: number[], sources: { name: string; kind: "dht" | "relay" }[], dhtFirst: boolean): Promise<number[]> {
    const network = new FakeTurnNetwork(sources);
    network.dhtFirst = dhtFirst;
    const old = await packet(40, 3, 0, { held: [0, 1, 2, 3] });
    network.seed(old);
    const allRead = deferred(), allPut = deferred();
    const read = new Set<number>(), put = new Set<number>();
    const turns = new Map(order.map((slot) => [slot, deferred()]));
    // A wait ends after every device's put: each put within T of its own read, each read before the first put.
    clock.onSleep = () => allPut.promise;
    const view = (slot: number): TurnNetwork => ({
      turnRead: async (key) => {
        const answers = await network.turnRead(key);
        if (!read.has(slot)) { read.add(slot); if (read.size === slotsRacing.length) allRead.resolve(); }
        return answers;
      },
      turnPut: async (key, payload, conditions) => {
        if (put.has(slot)) return network.turnPut(key, payload, conditions);
        put.add(slot);
        await allRead.promise;
        const before = order[order.indexOf(slot) - 1];
        if (before !== undefined) await turns.get(before)!.promise;
        const answers = await network.turnPut(key, payload, conditions);
        turns.get(slot)!.resolve();
        if (put.size === slotsRacing.length && order.at(-1) === slot) allPut.resolve();
        return answers;
      },
    });
    const set = deviceSet([0, 1, 2, 3]);
    const active = await Promise.all(slotsRacing.map(async (slot) => {
      if (slot === takerSlot) {
        const made = device(slot, view(slot), { ...recordOf(slot, "standby", 40, [0, 1, 2, 3], { deviceSet: set }), state: "taking" }, { undo: async () => {} });
        const first = (await made.keeper.read())!;
        await made.keeper.write(first.conditions, { turn: 41, release: await releaseTo(41, 0, slot) });
        return (await made.keeper.check(true)).kind === "start";
      }
      const made = device(slot, view(slot), recordOf(slot, "standby", 40, [0, 1, 2, 3], { deviceSet: set, turnPacket: toBase64Url(old), rev: 3, activeSlot: 0 }));
      return (await made.keeper.raise({ turn: 41 }))!.mine;
    }));
    return slotsRacing.filter((_, i) => active[i]);
  }

  const RELAY = [{ name: "https://relay.test", kind: "relay" as const }];
  const TWO_RELAYS = [...RELAY, { name: "https://other.test", kind: "relay" as const }];
  const MIXED = [{ name: "dht", kind: "dht" as const }, ...RELAY];
  const cases: [string, number[], number | null][] = [
    ["a taker in the lower slot and a device that forces the turn", [1, 2], 1],
    ["a taker in the higher slot and a device that forces the turn", [1, 2], 2],
    ["two devices that force the turn", [1, 2], null],
    ["a taker in the lowest slot and two devices that force the turn", [1, 2, 3], 1],
    ["a taker in the middle slot and two devices that force the turn", [1, 2, 3], 2],
    ["a taker in the highest slot and two devices that force the turn", [1, 2, 3], 3],
    ["three devices that force the turn", [1, 2, 3], null],
  ];

  it.each(cases)("%s, relays only, in every put order: exactly one is active, the one with the highest sequence", async (_name, racing, taker) => {
    for (const sources of [RELAY, TWO_RELAYS]) for (const order of orders(racing)) {
      const active = await race(racing, taker, order, sources, false);
      expect(active, `put order ${order.join(", ")} on ${sources.length} relay(s)`).toEqual([Math.max(...racing)]);
    }
  });

  it.each(cases)("%s, the DHT and a relay, in every put order: exactly one is active, the one whose put the DHT took", async (_name, racing, taker) => {
    for (const order of orders(racing)) {
      const active = await race(racing, taker, order, MIXED, true);
      expect(active, `put order ${order.join(", ")}`).toEqual([order[0]]);
    }
  });

  it("why the Desktop puts to the DHT first: a put the DHT refused that still landed on the relay can leave nobody active", async () => {
    // The taker (slot 2) puts second: the DHT refuses it, and with every source put to at once the relay takes it.
    // The device that forced the turn reads the taker's higher record on the relay and stops; the taker reads the
    // forcing device's record on the DHT and yields.
    expect(await race([1, 2], 2, [1, 2], MIXED, false)).toEqual([]);
    expect(await race([1, 2], 2, [1, 2], MIXED, true)).toEqual([1]);
  });
});
