import { describe, expect, it } from "vitest";
import { fromBase64Url, identityFromSeed, readTurnPacket, sign, toBase64Url, turnKeys, type Identity, type TurnRecord } from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import { TurnKeeper, type TurnStore } from "../src/devices/turn";
import { RenameRefusal, renameDevice, renamedDeviceName } from "../src/devices/rename";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.screens

/*
 * Rename (WISP 06 § User experience, the row menu): the active device writes its next record with the new name in the
 * slot, and the other device of the set takes it from the next record it reads. Two devices in one process, each a turn
 * keeper with a store of its own, over sources that behave as the DHT and a relay do.
 */

const D = new Uint8Array(32).fill(0xd0);
const keys = turnKeys(D);
const devices: Identity[] = [1, 2].map((n) => identityFromSeed(new Uint8Array(32).fill(n)));
const NAMES = ["Chrome, Windows", "Phone"];
const deviceSet = () => devices.map((device, i) => ({ key: toBase64Url(device.publicKey), name: NAMES[i] }));
const keyOf = (i: number) => toBase64Url(devices[i].publicKey);

function memoryStore(initial: DeviceRecord): TurnStore & { record: DeviceRecord; writes: DevicePatch[] } {
  const store = {
    record: initial, writes: [] as DevicePatch[],
    read: async (_profile: string) => store.record,
    amend: async (_profile: string, patch: DevicePatch) => { store.writes.push(patch); return (store.record = { ...amend(store.record, patch), saved: store.record.saved + 1 }); },
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => { store.writes.push({ ...patch }); return (store.record = { ...transition(store.record, profile, to, patch), saved: store.record.saved + 1 }); },
  };
  return store;
}

function device(own: number, network: FakeTurnNetwork, state: "active" | "standby", patch: DevicePatch = {}) {
  const store = memoryStore(firstRecord("ghostly", state, { turn: 40, d: toBase64Url(D), deviceSet: deviceSet(), ownSlot: own, ...patch }));
  let t = 1_000_000;
  const keeper = new TurnKeeper({ profile: "ghostly", network, store, signer: (bytes) => sign(bytes, devices[own].seed), now: () => t, sleep: async (ms) => { t += ms; } });
  const rename = (key: string, name: string) => renameDevice({ profile: "ghostly", keeper, key, name, read: async () => store.record });
  return { keeper, store, rename };
}

const opened = (payload: Uint8Array | null | undefined): TurnRecord => {
  const read = readTurnPacket(keys, payload!);
  if (read.kind !== "valid") throw new Error(`not a valid record: ${read.kind}`);
  return read.record;
};

/** The active device started, and the standby read its record: both hold the same set. */
async function pair() {
  const network = new FakeTurnNetwork();
  const active = device(0, network, "active");
  expect((await active.keeper.check(true)).kind).toBe("start");
  const standby = device(1, network, "standby");
  expect(await standby.keeper.check(true)).toMatchObject({ kind: "show", screen: "active-on", device: NAMES[0] });
  return { network, active, standby };
}

describe("renaming a device", () => {
  it("the active device writes rev plus one with the new name, and the standby shows it after its next read", async () => {
    const { network, active, standby } = await pair();
    const before = opened(network.source("dht").held);
    expect(await active.rename(keyOf(1), "  Pixel 9  ")).toBe(true);
    const after = opened(network.source("dht").held);
    // The record every app reads: the same turn, the next rev, the same keys, the one name changed.
    expect({ turn: after.turn, rev: after.rev, author: after.author, active: after.active }).toEqual({ turn: before.turn, rev: before.rev + 1, author: 0, active: 0 });
    expect(after.slots.map((slot) => slot && [toBase64Url(slot.key), slot.name])).toEqual([[keyOf(0), NAMES[0]], [keyOf(1), "Pixel 9"], null, null]);
    expect(active.store.record.deviceSet[1]).toEqual({ key: keyOf(1), name: "Pixel 9" });
    expect(standby.store.record.deviceSet[1]?.name).toBe("Phone");
    expect(await standby.keeper.check(false)).toMatchObject({ kind: "show", screen: "active-on", device: NAMES[0] });
    expect(standby.store.record.deviceSet.flatMap((slot) => (slot ? [slot.name] : []))).toEqual([NAMES[0], "Pixel 9"]);
    expect(standby.store.record.turnPacket).toBe(toBase64Url(network.source("dht").held!));
  });

  it("renames the active device itself, and the standby's screen names it so", async () => {
    const { active, standby } = await pair();
    expect(await active.rename(keyOf(0), "Office PC")).toBe(true);
    expect(await standby.keeper.check(false)).toMatchObject({ kind: "show", screen: "active-on", device: "Office PC" });
    // The active device's next start writes the next record from the name it stored.
    expect((await active.keeper.check(true)).kind).toBe("start");
    expect(await standby.keeper.check(false)).toMatchObject({ kind: "show", device: "Office PC" });
  });

  it("writes nothing for the name the slot already holds", async () => {
    const { network, active } = await pair();
    const puts = network.puts().length;
    expect(await active.rename(keyOf(1), " Phone ")).toBe(false);
    expect(network.puts().length).toBe(puts);
  });

  it("keeps a takeover's offer pointing at the device it renamed", async () => {
    const network = new FakeTurnNetwork();
    const active = device(0, network, "active", { secretOffer: { why: "takeover", at: 1, device: "Phone" } });
    expect((await active.keeper.check(true)).kind).toBe("start");
    await active.rename(keyOf(1), "Old phone");
    expect(active.store.record.secretOffer).toMatchObject({ why: "takeover", device: "Old phone" });
  });

  it("refuses a name the record would change, before anything is read or written", async () => {
    const { network, active } = await pair();
    const calls = network.calls.length;
    for (const [name, reason] of [["", "name"], ["   ", "name"], ["\u200b", "name"], ["Phone\u202e", "name"], ["Ph\u0007one", "name"], ["A".repeat(17), "long"], ["ééééééééé", "long"]] as const) {
      await expect(active.rename(keyOf(1), name), JSON.stringify(name)).rejects.toMatchObject({ reason, message: expect.stringMatching(new RegExp(`^rename-${reason}:`)) });
    }
    expect(network.calls.length).toBe(calls);
    expect(active.store.record.deviceSet[1]?.name).toBe("Phone");
  });

  it("keeps what a slot keeps: 16 bytes, an emoji sequence whole, the joiner inside it", () => {
    expect(renamedDeviceName("A".repeat(16))).toBe("A".repeat(16));
    expect(renamedDeviceName("Mãe 👩‍💻")).toBe("Mãe 👩‍💻");
    expect(renamedDeviceName("می‌خوام")).toBe("می‌خوام");
    expect(() => renamedDeviceName(42)).toThrow(RenameRefusal);
  });

  it("refuses a joiner or a variation selector that joins nothing: the name would look like one it is not", () => {
    for (const name of ["Phone‍", "‍Phone", "Pho‌ne", "Phone️"]) {
      expect(() => renamedDeviceName(name), JSON.stringify(name)).toThrow(/^rename-name:/);
    }
  });

  it("refuses on a standby, for a device not in the set, and when another device holds the turn", async () => {
    const { network, active, standby } = await pair();
    await expect(standby.rename(keyOf(1), "Mine")).rejects.toMatchObject({ reason: "state" });
    await expect(active.rename(toBase64Url(identityFromSeed(new Uint8Array(32).fill(9)).publicKey), "Ghost")).rejects.toMatchObject({ reason: "device" });
    // The standby took the turn meanwhile (a takeover): the old active device writes nothing and learns it was replaced.
    expect((await standby.keeper.raise())?.kind).toBe("start");
    const held = network.source("dht").held;
    await expect(active.rename(keyOf(1), "Pixel")).rejects.toMatchObject({ reason: "replaced" });
    expect(network.source("dht").held).toEqual(held);
    expect(active.store.record.state).toBe("superseded");
  });

  it("refuses when no source answers, and writes nothing", async () => {
    const { network, active } = await pair();
    for (const source of network.sources) source.down = true;
    const packet = active.store.record.turnPacket;
    await expect(active.rename(keyOf(1), "Pixel")).rejects.toMatchObject({ reason: "unreachable" });
    expect(active.store.record.turnPacket).toBe(packet);
    expect(fromBase64Url(packet!).length).toBeGreaterThan(0);
  });
});
