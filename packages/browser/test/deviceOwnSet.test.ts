import { describe, expect, it } from "vitest";
import { TURN_SETTLE_MS, bytesEqual, classifyTurnRead, fromBase64Url, readTurnPacket, seedSigner, signTombstone, toBase64Url, turnKeys, type Signer } from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type DeviceSlot, type StoredDeviceState } from "../src/devices/state";
import { canStartOwnSet, instanceBelow, resumeOwnSet, startOwnSet, type OwnSetPorts } from "../src/devices/ownSet";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.remove.own-set

/*
 * When the remover is gone for good (WISP 06 § Removing a device): a `moving` device that holds a frozen copy makes a
 * device set of its own, puts a tombstone at the old address that lists only itself, waits the settle time and starts
 * only if that tombstone is its own. Every key and secret is made in the test; the network keeps one packet per source
 * as the real ones were measured to (`helpers/turnNetwork.ts`).
 */

const label = (n: number) => new Uint8Array(32).fill(n);
const signers: Signer[] = [1, 2, 3, 4].map((n) => seedSigner(label(80 + n)));
const NAMES = ["Desktop", "Phone", "Tablet", "Laptop"];
const OLD_D = label(0xd2);
const oldKeys = turnKeys(OLD_D);
const slot = (i: number): DeviceSlot => ({ key: toBase64Url(signers[i]!.publicKey), name: NAMES[i]! });
const VERIFIER = { v: 1 as const, setup: "c2V0dXA", record: "cmVjb3Jk" };
const PASSWORD = "the lock password";

interface Device { store: { record: DeviceRecord }; ports: OwnSetPorts; slept: number[] }

/** The remover (Desktop) removed the Laptop: its tombstone keeps itself, the Phone and the Tablet. Then it was lost for good. */
async function world(): Promise<FakeTurnNetwork> {
  const network = new FakeTurnNetwork();
  const tomb = await signTombstone(oldKeys, 0, [0, 1, 2, 3].map((i) => (i < 3 ? { key: signers[i]!.publicKey, name: NAMES[i]! } : null)), (bytes) => signers[0]!.sign(bytes));
  network.seed(tomb);
  return network;
}

function device(network: FakeTurnNetwork | null, own: number, patch: DevicePatch = {}, sleep?: (ms: number) => Promise<void>): Device {
  const store = {
    record: { ...firstRecord("ghostly", "standby", { turn: 77, rev: 1, d: toBase64Url(OLD_D), deviceSet: [slot(0), slot(1), slot(2), slot(3)], ownSlot: own, activeSlot: 0, copy: "frozen", verifier: VERIFIER, takeovers: 2, ...patch }), state: "moving" as StoredDeviceState, saved: 1 },
  };
  const slept: number[] = [];
  const ports: OwnSetPorts = {
    read: async () => store.record,
    amend: async (p) => (store.record = { ...amend(store.record, p), saved: store.record.saved + 1 }),
    move: async (to, p = {}) => (store.record = { ...transition(store.record, "ghostly", to, p), saved: store.record.saved + 1 }),
    proves: async (_verifier, password) => password === PASSWORD,
    signer: (bytes) => signers[own]!.sign(bytes),
    network,
    sleep: async (ms) => { slept.push(ms); await sleep?.(ms); },
  };
  return { store, ports, slept };
}

describe("a device set of its own, from moving", () => {
  it("is offered only on a moving device with a copy that still believes its remover", () => {
    const base = device(null, 1).store.record;
    expect(canStartOwnSet(base)).toBe(true);
    expect(canStartOwnSet({ ...base, copy: undefined })).toBe(false);
    expect(canStartOwnSet({ ...base, reenroll: true })).toBe(false);
    expect(canStartOwnSet({ ...base, state: "standby" })).toBe(false);
    expect(canStartOwnSet(null)).toBe(false);
  });

  it("its tombstone's instance is below the one that stands at the old address, so a remover's that is gone cannot outrank it", () => {
    const under = Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 0]);
    for (let i = 0; i < 50; i++) {
      const got = instanceBelow(under);
      expect(got).toHaveLength(8);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(under))).toBe(-1);
    }
    // Nothing stands there (or a zero instance, which nothing is below): any.
    expect(instanceBelow(undefined)).toHaveLength(8);
    expect(instanceBelow(new Uint8Array(8))).toHaveLength(8);
  });

  it("a wrong password or name, or no network: refused, nothing put, the wrong password counted", async () => {
    const network = await world();
    const phone = device(network, 1);
    await expect(startOwnSet(phone.ports, { password: "wrong", name: "Desktop" })).rejects.toThrow(/^takeover-password:/);
    expect(phone.store.record.takeoverAttempts?.total).toBe(1);
    await expect(startOwnSet(phone.ports, { password: PASSWORD, name: "Laptop" })).rejects.toThrow(/^takeover-name:/);
    await expect(startOwnSet(device(null, 1).ports, { password: PASSWORD, name: "Desktop" })).rejects.toThrow(/^takeover-offline:/);
    await expect(startOwnSet(device(network, 1, { copy: undefined }).ports, { password: PASSWORD, name: "Desktop" })).rejects.toThrow(/^takeover-no-copy:/);
    expect(network.puts()).toEqual([]);
    expect(phone.store.record.ownSet).toBeUndefined();
  });

  it("puts a tombstone that lists only itself, waits the settle time, and is the active device of a set of its own", async () => {
    const network = await world();
    const phone = device(network, 1);
    expect(await startOwnSet(phone.ports, { password: PASSWORD, name: "desktop" })).toBe("start");
    expect(phone.slept).toHaveLength(1);
    expect(phone.slept[0]).toBeGreaterThan(TURN_SETTLE_MS - 1_000);
    const record = phone.store.record;
    expect(record.state).toBe("active");
    // A new secret, itself the only device, in its own slot, with the first record at the new address stored.
    expect(record.d).not.toBe(toBase64Url(OLD_D));
    expect(record.deviceSet).toEqual([null, slot(1), null, null]);
    expect(record.activeSlot).toBe(1);
    const first = readTurnPacket(turnKeys(fromBase64Url(record.d!)), fromBase64Url(record.turnPacket!));
    expect(first.kind).toBe("valid");
    // One more takeover, the counters raised before the engine starts; no copy apart, no plan, no wait for a set-update.
    expect(record.takeovers).toBe(3);
    expect(record.raise).toMatchObject({ why: "takeover", takeovers: 3 });
    expect(record.copy).toBeUndefined();
    expect(record.ownSet).toBeUndefined();
    // The old address holds its tombstone, which lists this device alone, and is put again every hour as an earlier set's.
    const held = network.source("dht").held!;
    expect(record.earlierSets).toEqual([{ d: toBase64Url(OLD_D), tombstone: toBase64Url(held), setUpdate: "", pending: [] }]);
    const read = classifyTurnRead({ keys: oldKeys, ownKey: signers[2]!.publicKey, stored: null }, await network.turnRead());
    expect(read).toMatchObject({ result: "tombstone", listed: false });
  });

  it("the plan is stored before the tombstone leaves the device, and a reload while it settles resumes it", async () => {
    const network = await world();
    let stop = true;
    const phone = device(network, 1, {}, async () => { if (stop) throw new Error("the app stopped"); });
    network.onPut = () => { expect(phone.store.record.ownSet).toBeDefined(); };
    await expect(startOwnSet(phone.ports, { password: PASSWORD, name: "Desktop" })).rejects.toThrow("the app stopped");
    expect(phone.store.record).toMatchObject({ state: "moving", ownSet: { at: expect.any(Number) } });
    const putsBefore = network.puts().length;
    stop = false;
    expect(await resumeOwnSet(phone.ports)).toBe("start");
    // The put that ended is not made again.
    expect(network.puts().length).toBe(putsBefore);
  });

  it("two moving devices at once: they read the same packet, one starts and the other is removed", async () => {
    const network = await world();
    const tablet = device(network, 2);
    let tabletOutcome: string | undefined;
    // The tablet does the same while the phone waits: its whole run lands inside the phone's settle time.
    const phone = device(network, 1, {}, async () => { if (!tabletOutcome) tabletOutcome = await startOwnSet(tablet.ports, { password: PASSWORD, name: "Desktop" }); });
    const phoneOutcome = await startOwnSet(phone.ports, { password: PASSWORD, name: "Desktop" });
    expect([phoneOutcome, tabletOutcome].sort()).toEqual(["removed", "start"]);
    const winner = phoneOutcome === "start" ? phone : tablet, loser = phoneOutcome === "start" ? tablet : phone;
    expect(winner.store.record.state).toBe("active");
    expect(loser.store.record).toMatchObject({ state: "removed" });
    expect(loser.store.record.ownSet).toBeUndefined();
    // What counts at the old address is the winner's own tombstone.
    const read = classifyTurnRead({ keys: oldKeys, ownKey: signers[0]!.publicKey, stored: null }, await network.turnRead());
    expect(bytesEqual(read.payload!, fromBase64Url(winner.store.record.earlierSets.at(-1)!.tombstone))).toBe(true);
  });

  it("the remover's tombstone comes back on top: still moving, and it may try again", async () => {
    const network = await world();
    const removers = network.source("dht").held!;
    const phone = device(network, 1, {}, async () => { network.seed(removers); });
    expect(await startOwnSet(phone.ports, { password: PASSWORD, name: "Desktop" })).toBe("lost");
    expect(phone.store.record.state).toBe("moving");
    expect(phone.store.record.ownSet).toBeUndefined();
    expect(canStartOwnSet(phone.store.record)).toBe(true);
  });

  it("a source that took the put does not answer the settle read: no read that counts, the plan kept", async () => {
    const network = await world();
    let once = true;
    const phone = device(network, 1, {}, async () => { if (once) network.source("dht").down = true; once = false; });
    expect(await startOwnSet(phone.ports, { password: PASSWORD, name: "Desktop" })).toBe("wait");
    expect(phone.store.record).toMatchObject({ state: "moving", ownSet: { at: expect.any(Number) } });
    network.source("dht").down = false;
    expect(await resumeOwnSet(phone.ports)).toBe("start");
  });

  it("the remover's new secret arrived after all (a standby of that set now): the plan is void", async () => {
    const network = await world();
    const phone = device(network, 1, {}, async () => { phone.store.record = { ...transition(phone.store.record, "ghostly", "standby", {}), saved: phone.store.record.saved + 1 }; });
    expect(await startOwnSet(phone.ports, { password: PASSWORD, name: "Desktop" })).toBe("lost");
    expect(phone.store.record).toMatchObject({ state: "standby" });
    expect(phone.store.record.ownSet).toBeUndefined();
  });
});
