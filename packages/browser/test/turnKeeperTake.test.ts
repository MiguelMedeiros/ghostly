import { beforeEach, describe, expect, it } from "vitest";
import {
  fromBase64Url, identityFromSeed, readTurnPacket, sign, signTurnPacket, signTurnRelease, toBase64Url, turnKeys, TURN_SETTLE_MS,
  type Identity, type TurnRecord, type TurnRelease,
} from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import { TurnKeeper, type TurnStore } from "../src/devices/turn";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.turn.keeper, devices.handoff.take

/*
 * The take at the end of a handoff (WISP 06 § Shape, step 8): a `taking` device that holds the release of `N + 1`
 * writes that turn with the release within `P` of its read, waits `T`, reads every source again, and is active only on
 * `mine`. Before it wrote, the releaser's record at `N` is no rival; anything at or above `N + 1` that is not its own is.
 */

const D = new Uint8Array(32).fill(0xd0);
const keys = turnKeys(D);
const devices: Identity[] = [1, 2, 3].map((n) => identityFromSeed(new Uint8Array(32).fill(n)));
const NAMES = ["Desktop", "Phone", "Laptop"];
const deviceSet = () => devices.map((device, i) => ({ key: toBase64Url(device.publicKey), name: NAMES[i] }));
const slots = () => [...devices.map((device, i) => ({ key: device.publicKey, name: NAMES[i] })), null];
const N = 500;

function memoryStore(initial: DeviceRecord): TurnStore & { record: DeviceRecord } {
  const store = {
    record: initial,
    read: async () => store.record,
    amend: async (_profile: string, patch: DevicePatch) => (store.record = { ...amend(store.record, patch), saved: store.record.saved + 1 }),
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => (store.record = { ...transition(store.record, profile, to, patch), saved: store.record.saved + 1 }),
  };
  return store;
}

const clock = { t: 5_000_000, slept: [] as number[], onSleep: undefined as (() => Promise<void>) | undefined };
beforeEach(() => { clock.t = 5_000_000; clock.slept = []; clock.onSleep = undefined; });

async function packet(turn: number, rev: number, author: number, release?: TurnRelease): Promise<Uint8Array> {
  return signTurnPacket(keys, { turn, rev, author, active: author, slots: slots(), instance: new Uint8Array(8).fill(author + 1), ...(release ? { release } : {}) }, (bytes) => sign(bytes, devices[author].seed));
}
const releaseTo = (turn: number, from: number, to: number) => signTurnRelease(keys.address, turn, from, to, devices[to].publicKey, new Uint8Array(32).fill(7), (bytes) => sign(bytes, devices[from].seed));
const opened = (payload: Uint8Array | string | null | undefined): TurnRecord => {
  const read = readTurnPacket(keys, typeof payload === "string" ? fromBase64Url(payload) : payload!);
  if (read.kind !== "valid") throw new Error(`not a valid record: ${read.kind}`);
  return read.record;
};

/** The taker (slot 1): `taking`, holding the releaser's record of turn `N` it accepted as a standby. */
async function taker(network: FakeTurnNetwork, undo?: () => Promise<void>) {
  const stored = await packet(N, 0, 0);
  const record = { ...firstRecord("ghostly", "standby", { turn: N, d: toBase64Url(D), deviceSet: deviceSet(), ownSlot: 1, activeSlot: 0, turnPacket: toBase64Url(stored) }) };
  const store = memoryStore({ ...transition(record, "ghostly", "taking", { handoff: { role: "taking", step: "installed" } }), saved: 2 });
  const keeper = new TurnKeeper({
    profile: "ghostly", network, store, signer: (bytes) => sign(bytes, devices[1].seed), now: () => clock.t,
    sleep: async (ms) => { clock.slept.push(ms); await clock.onSleep?.(); clock.t += ms; },
    ...(undo ? { undoStaging: undo } : {}),
  });
  return { keeper, store, stored };
}

describe("the take of a handoff", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("over the releaser's record: writes N + 1 with the release, conditional on N, waits T, and is active on mine", async () => {
    const { keeper, store, stored } = await taker(network);
    network.seed(stored);
    const release = await releaseTo(N + 1, 0, 1);
    const outcome = await keeper.take(release, N + 1);
    expect(outcome?.kind).toBe("start");
    expect(store.record.state).toBe("active");
    const record = opened(network.source("dht").held);
    expect({ turn: record.turn, rev: record.rev, author: record.author, active: record.active }).toEqual({ turn: N + 1, rev: 0, author: 1, active: 1 });
    expect(record.release && { from: record.release.from, to: record.release.to, signature: toBase64Url(record.release.signature) }).toEqual({ from: 0, to: 1, signature: toBase64Url(release.signature) });
    // Its put named what each source held: the releaser's record.
    const sequence = String(N * 2 ** 20);
    expect(network.puts().map((p) => [p.source, p.condition])).toEqual([["dht", sequence], ["https://relay.test", sequence]]);
    expect(clock.slept).toEqual([TURN_SETTLE_MS]);
    expect(store.record.settle).toBeUndefined();
  });

  it("over a later rev of the releaser's turn it never stored (the releaser started again since): still no rival", async () => {
    const { keeper, store } = await taker(network);
    network.seed(await packet(N, 3, 0));
    expect((await keeper.take(await releaseTo(N + 1, 0, 1), N + 1))?.kind).toBe("start");
    expect(store.record.state).toBe("active");
  });

  it("with no record anywhere (the releaser's expired): puts with no condition and settles", async () => {
    const { keeper } = await taker(network);
    expect((await keeper.take(await releaseTo(N + 1, 0, 1), N + 1))?.kind).toBe("start");
    expect(network.puts().every((p) => p.condition === null)).toBe(true);
  });

  it("a third device forced N + 1 before the take: the taker yields without putting, steps back and is standby", async () => {
    let undone = 0;
    const { keeper, store } = await taker(network, async () => { undone += 1; });
    network.seed(await packet(N + 1, 0, 2));
    const outcome = await keeper.take(await releaseTo(N + 1, 0, 1), N + 1);
    expect(outcome).toMatchObject({ kind: "gated", state: "standby" });
    expect(undone).toBe(1);
    expect(store.record.state).toBe("standby");
    expect(network.puts()).toEqual([]);
  });

  it("the releaser took the turn back at N + 2 (it waited for a taker that never came): the taker yields", async () => {
    let undone = 0;
    const { keeper, store } = await taker(network, async () => { undone += 1; });
    network.seed(await packet(N + 2, 0, 0));
    expect((await keeper.take(await releaseTo(N + 1, 0, 1), N + 1))?.kind).toBe("gated");
    expect(undone).toBe(1);
    expect(store.record.state).toBe("standby");
  });

  it("a third device forces N + 1 during the settle wait, from a higher slot: the taker's settle read says other, and it yields", async () => {
    let undone = 0;
    const { keeper, store } = await taker(network, async () => { undone += 1; });
    network.seed(await packet(N, 0, 0));
    clock.onSleep = async () => { network.seed(await packet(N + 1, 0, 2)); };
    const outcome = await keeper.take(await releaseTo(N + 1, 0, 1), N + 1);
    expect(outcome?.kind).toBe("gated");
    expect(undone).toBe(1);
    expect(store.record.state).toBe("standby");
  });

  it("no source answers: it waits, and writes nothing", async () => {
    const { keeper, store } = await taker(network);
    for (const source of network.sources) source.down = true;
    expect((await keeper.take(await releaseTo(N + 1, 0, 1), N + 1))?.kind).toBe("wait");
    expect(store.record.state).toBe("taking");
    expect(network.puts()).toEqual([]);
  });

  it("an app that stopped while it settled: reads, puts the same stored bytes again and waits the whole of T", async () => {
    const { keeper, store } = await taker(network);
    const release = await releaseTo(N + 1, 0, 1);
    // The first take wrote and put, and the app stopped during the wait.
    clock.onSleep = async () => { throw new Error("the app stopped"); };
    await expect(keeper.take(release, N + 1)).rejects.toThrow("the app stopped");
    const written = store.record.turnPacket;
    expect(opened(written).turn).toBe(N + 1);
    clock.onSleep = undefined;
    clock.slept = [];
    network.calls.length = 0;
    const again = new TurnKeeper({ profile: "ghostly", network, store, signer: (bytes) => sign(bytes, devices[1].seed), now: () => clock.t, sleep: async (ms) => { clock.slept.push(ms); clock.t += ms; } });
    expect((await again.take(release, N + 1))?.kind).toBe("start");
    expect(store.record.turnPacket).toBe(written);
    expect(network.puts().map((p) => toBase64Url(p.payload!))).toEqual([written, written]);
    expect(clock.slept).toEqual([TURN_SETTLE_MS]);
  });

  it("refuses a device that is not taking", async () => {
    const { keeper, store } = await taker(network);
    store.record = { ...store.record, state: "standby" };
    await expect(keeper.take(await releaseTo(N + 1, 0, 1), N + 1)).rejects.toThrow("holds a release");
  });
});
