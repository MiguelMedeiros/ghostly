import { beforeEach, describe, expect, it } from "vitest";
import { fromBase64Url, identityFromSeed, readTurnPacket, sign, signTurnPacket, signTurnRelease, toBase64Url, turnKeys, type Identity, type TurnRecord } from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type DeviceSlot, type StoredDeviceState } from "../src/devices/state";
import { TurnKeeper, type TurnStore } from "../src/devices/turn";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.turn.keeper, devices.handoff.take, devices.takeover

/*
 * The set the first record of a raised turn lists (WISP 06 § Who may raise the turn): a forced takeover and a handoff's
 * taker write the set of the newest record of the set they know, which the read they act on may have just returned,
 * not only the one they stored. Three devices of one person: Desktop active (slot 0), Phone on standby (slot 1), and
 * Laptop (slot 2), added while the Phone did not read.
 */

const D = new Uint8Array(32).fill(0xd0);
const keys = turnKeys(D);
const devices: Identity[] = [1, 2, 3].map((n) => identityFromSeed(new Uint8Array(32).fill(n)));
const keyOf = (i: number) => toBase64Url(devices[i].publicKey);
const N = 500;

/** A set of the three devices by name; null leaves the slot empty. */
const named = (names: (string | null)[]): (DeviceSlot | null)[] => [0, 1, 2, 3].map((i) => (names[i] ? { key: keyOf(i), name: names[i]! } : null));
const TWO = named(["Desktop", "Phone"]);
const THREE = named(["Desktop", "Phone", "Laptop"]);

function memoryStore(initial: DeviceRecord): TurnStore & { record: DeviceRecord } {
  const store = {
    record: initial,
    read: async () => store.record,
    amend: async (_profile: string, patch: DevicePatch) => (store.record = { ...amend(store.record, patch), saved: store.record.saved + 1 }),
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => (store.record = { ...transition(store.record, profile, to, patch), saved: store.record.saved + 1 }),
  };
  return store;
}

const clock = { t: 5_000_000 };
beforeEach(() => { clock.t = 5_000_000; });

/** A record of the Desktop's (slot 0) turn `turn`, at `rev`, listing `set`. */
const desktop = (turn: number, rev: number, set: (DeviceSlot | null)[]) => signTurnPacket(keys, {
  turn, rev, author: 0, active: 0, instance: new Uint8Array(8).fill(rev + 1),
  slots: set.map((slot) => slot && { key: fromBase64Url(slot.key), name: slot.name }),
}, (bytes) => sign(bytes, devices[0].seed));

/** Device `own` holding `stored` (the Desktop's record it last read) and the set it lists, in `state`. */
function device(own: number, network: FakeTurnNetwork, state: StoredDeviceState, stored: Uint8Array, set: (DeviceSlot | null)[], patch: DevicePatch = {}) {
  const record = firstRecord("ghostly", "standby", { turn: N, d: toBase64Url(D), deviceSet: set, ownSlot: own, activeSlot: 0, turnPacket: toBase64Url(stored), copy: "frozen" });
  const store = memoryStore(state === "standby" ? record : { ...transition(record, "ghostly", state, patch), saved: 2 });
  const keeper = new TurnKeeper({ profile: "ghostly", network, store, signer: (bytes) => sign(bytes, devices[own].seed), now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, undoStaging: async () => {} });
  return { keeper, store };
}

const opened = (payload: Uint8Array | null | undefined): TurnRecord => {
  const read = readTurnPacket(keys, payload!);
  if (read.kind !== "valid") throw new Error(`not a valid record: ${read.kind}`);
  return read.record;
};
const names = (set: readonly ({ name: string } | null)[]) => set.map((slot) => slot?.name ?? null);

describe("the set a raised turn lists", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("a forced takeover over a record that added a device it never read: the device stays listed, and it knows it is", async () => {
    const before = await desktop(N, 0, TWO);
    const added = await desktop(N, 1, THREE);
    network.seed(added);
    const phone = device(1, network, "standby", before, TWO);
    const laptop = device(2, network, "standby", added, THREE);
    expect((await phone.keeper.raise())?.kind).toBe("start");
    const written = opened(network.source("dht").held);
    expect({ turn: written.turn, author: written.author, active: written.active }).toEqual({ turn: N + 1, author: 1, active: 1 });
    expect(names(written.slots)).toEqual(["Desktop", "Phone", "Laptop", null]);
    expect(phone.store.record.deviceSet).toEqual(THREE);
    // The Laptop reads the takeover and names the Phone active: it is in the set, and can be removed from it.
    expect(await laptop.keeper.check(false)).toMatchObject({ kind: "show", screen: "active-on", device: "Phone", forced: true });
    expect(names(laptop.store.record.deviceSet)).toEqual(["Desktop", "Phone", "Laptop", null]);
  });

  it("a forced takeover after a rename it never read: the names are kept", async () => {
    const before = await desktop(N, 0, TWO);
    network.seed(await desktop(N, 1, named(["Office PC", "Pixel 9"])));
    const phone = device(1, network, "standby", before, TWO);
    expect((await phone.keeper.raise())?.kind).toBe("start");
    expect(names(opened(network.source("dht").held).slots)).toEqual(["Office PC", "Pixel 9", null, null]);
    expect(names(phone.store.record.deviceSet)).toEqual(["Office PC", "Pixel 9", null, null]);
  });

  it("the taker of a handoff over a later rev of the releaser's turn: writes that rev's set, the device added and the rename", async () => {
    const before = await desktop(N, 0, TWO);
    network.seed(await desktop(N, 2, named(["Office PC", "Phone", "Laptop"])));
    const phone = device(1, network, "taking", before, TWO, { handoff: { role: "taking", step: "installed" } });
    const release = await signTurnRelease(keys.address, N + 1, 0, 1, devices[1].publicKey, new Uint8Array(32).fill(7), (bytes) => sign(bytes, devices[0].seed));
    expect((await phone.keeper.take(release, N + 1))?.kind).toBe("start");
    const written = opened(network.source("dht").held);
    expect({ turn: written.turn, active: written.active, release: written.release?.from }).toEqual({ turn: N + 1, active: 1, release: 0 });
    expect(names(written.slots)).toEqual(["Office PC", "Phone", "Laptop", null]);
    expect(names(phone.store.record.deviceSet)).toEqual(["Office PC", "Phone", "Laptop", null]);
  });

  it("keeps a device its stored set lists in a slot the newer record leaves empty", async () => {
    // The Phone learned of the Laptop from a record it did not store (it was replaced, `superseded`); a lagging source
    // returns a record between the two.
    const before = await desktop(N, 0, TWO);
    network.seed(await desktop(N, 1, named(["Office PC", "Phone"])));
    const phone = device(1, network, "standby", before, THREE);
    expect((await phone.keeper.raise())?.kind).toBe("start");
    expect(names(opened(network.source("dht").held).slots)).toEqual(["Office PC", "Phone", "Laptop", null]);
  });

  it("writes its stored set when the newer record does not list it in its own slot, or is no newer", async () => {
    const before = await desktop(N, 1, THREE);
    network.seed(await desktop(N, 2, named(["Desktop", null, "Laptop"])));
    const phone = device(1, network, "standby", before, THREE);
    expect((await phone.keeper.raise())?.kind).toBe("start");
    expect(names(opened(network.source("dht").held).slots)).toEqual(["Desktop", "Phone", "Laptop", null]);

    const other = new FakeTurnNetwork();
    other.seed(await desktop(N, 0, TWO));
    const stale = device(1, other, "standby", before, THREE);
    expect((await stale.keeper.raise())?.kind).toBe("start");
    expect(names(opened(other.source("dht").held).slots)).toEqual(["Desktop", "Phone", "Laptop", null]);
  });
});
