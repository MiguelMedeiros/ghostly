import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstDeviceSetSecret, identityFromSeed, sign, signTurnPacket, turnKeys, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { createPeerServer } from "../src/devices/peer";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { RESTORE_UNCHECKED_KEY, markRestoreUnchecked, restoreCase, restoreCheckOf, restoreUncheckedOf } from "../src/devices/restoreGuard";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { closeDeviceKeysDb } from "../src/devices/signingKey";
import { STORES, databaseName, openDb, transact, wrap, store } from "../src/shared/idb";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { dropDevicesDatabase } from "./helpers/deviceRecord";
// covers: devices.restore-guard, devices.turn.limited

/*
 * A backup made before the profile had devices, restored while its turn could not be read (WISP 06 § A backup restored
 * where a device set exists, case 5). Before, the copy was restored as a profile of one device and started live: a
 * second live copy wherever the profile had gone on to have devices. Now it starts in limited mode (nothing published,
 * dialled, paid or administered), reads the turn of its first device-set secret every 30 seconds, and leaves limited
 * mode by itself when no device runs the profile, or goes on standby when one does. Every key is made in the test.
 */

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates();
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase();
  const stores = [STORES.settings, STORES.links, STORES.messages];
  await openDb();
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); resetDeviceGates(); });

const nodes: GhostlyNode[] = [];

/** A transport over a fake turn network that records every publish. Nothing leaves the process. */
function transportOver(network: FakeTurnNetwork) {
  const published: string[] = [];
  const transport: PkarrTransport = {
    publish: async () => { published.push("publish"); },
    publishPayload: async () => { published.push("publishPayload"); },
    resolve: async () => null,
    describe: () => ({ protocol: "recording", relays: [] }),
    turnRead: (key, options) => network.turnRead(key, options),
    turnPut: (key, payload, conditions) => network.turnPut(key, payload, conditions),
  };
  return { transport, published };
}

describe("the case of a restore whose bundle has no device set and whose turn cannot be read", () => {
  it("is its own case, not a plain restore", () => {
    expect(restoreCase(undefined, null)).toBe("unchecked");
    expect(restoreCase(undefined, { result: "unreachable" })).toBe("unchecked");
    expect(restoreCase(undefined, { result: "closed" })).toBe("unchecked");
    // A bundle that leads to no turn address at all is plain, whatever the read.
    expect(restoreCase(undefined, null, false)).toBe("plain");
    expect(restoreCase(undefined, { result: "none" })).toBe("plain");
    expect(restoreCheckOf(null)).toBe("wait");
    expect(restoreCheckOf({ result: "none" })).toBe("single");
    expect(restoreCheckOf({ result: "tombstone" })).toBe("removed");
    expect(restoreCheckOf({ result: "other", record: { turn: 3, active: 0, slots: [] } })).toBe("standby");
  });
});

describe("a restored copy whose turn was not read", () => {
  it("starts limited, publishes nothing while no read answers, and starts properly once one says no device runs it", async () => {
    await markRestoreUnchecked(databaseName(), "Laptop");
    expect(await restoreUncheckedOf(databaseName())).toMatchObject({ v: 1, name: "Laptop" });
    const network = new FakeTurnNetwork();
    for (const source of network.sources) source.down = true;
    const { transport, published } = transportOver(network);
    await wrap((await store(STORES.settings, "readwrite")).put({ online: true }, "settings"));
    const gate = await openDeviceGate();
    expect(gate).toMatchObject({ state: "single", full: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const peer = await createPeerServer({ transport, automaticWallets: false }, { gate });
    const node = (peer as unknown as { node: GhostlyNode }).node;
    nodes.push(node);
    await vi.advanceTimersByTimeAsync(100);
    await peer.ready;
    expect(node.limited).toBe(true);
    expect(node.getState().restoreCheck).toBe("checking");
    const reads = () => network.calls.filter((call) => call.op === "read").length;
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
    // No source answers: still limited, and read again after 30 seconds.
    const first = reads();
    await vi.advanceTimersByTimeAsync(GhostlyNode.RESTORE_CHECK_EVERY_MS);
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(first));
    expect(node.limited).toBe(true);
    expect(published).toEqual([]);
    // The sources answer, with nothing at the address: a profile of one device. Limited mode ends by itself.
    for (const source of network.sources) source.down = false;
    await vi.advanceTimersByTimeAsync(GhostlyNode.RESTORE_CHECK_EVERY_MS);
    await vi.waitFor(() => expect(node.limited).toBe(false));
    expect(node.getState().restoreCheck).toBeUndefined();
    expect(await restoreUncheckedOf(databaseName())).toBeNull();
    expect(await readDeviceRecord(databaseName())).toBeNull();
  });

  it("goes on standby as a restored copy when a read finds another device running the profile", async () => {
    await markRestoreUnchecked(databaseName(), "Laptop");
    const network = new FakeTurnNetwork();
    const { transport, published } = transportOver(network);
    const onDeviceGate = vi.fn();
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate }, { transport, automaticWallets: false });
    nodes.push(node);
    // The read the start schedules waits on a timer this test holds: the read below is the only one.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await node.start();
    // The profile's DID leads to the first device-set secret; a phone holds the turn there.
    const seed = await (node as unknown as { did: { deviceSetSeed(): Promise<Uint8Array> } }).did.deviceSetSeed();
    const keys = turnKeys(firstDeviceSetSecret(seed));
    const phone = identityFromSeed(new Uint8Array(32).fill(7));
    const slots = [{ key: phone.publicKey, name: "Phone" }, null, null, null];
    network.seed(await signTurnPacket(keys, { turn: 40, rev: 0, author: 0, active: 0, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => sign(bytes, phone.seed)));
    await (node as unknown as { readRestoredTurn(): Promise<string> }).readRestoredTurn();
    const record = await readDeviceRecord(databaseName());
    expect(record).toMatchObject({ state: "standby", copy: "restored", activeSlot: 0, ownSlot: 1, turn: 40 });
    expect(record!.deviceSet[1]?.name).toBe("Laptop");
    expect(onDeviceGate).toHaveBeenCalledWith(expect.objectContaining({ state: "standby", reload: true }));
    expect(await restoreUncheckedOf(databaseName())).toBeNull();
    expect(published).toEqual([]);
  });

  it("stays limited when the read finds a tombstone, until the person starts it as a profile of its own", async () => {
    await markRestoreUnchecked(databaseName(), "Laptop");
    const network = new FakeTurnNetwork();
    const { transport } = transportOver(network);
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    const inner = node as unknown as { readRestoredTurn(): Promise<string>; restoreCheck: string | null };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await node.start();
    const peek = await import("../src/devices/restoreGuard");
    vi.spyOn(peek, "peekTurn").mockResolvedValue({ result: "tombstone" });
    await inner.readRestoredTurn();
    expect(node.limited).toBe(true);
    expect(node.getState().restoreCheck).toBe("removed");
    await node.deviceRestoreStartOwn();
    expect(node.limited).toBe(false);
    expect(await wrap((await store(STORES.settings, "readonly")).get(RESTORE_UNCHECKED_KEY))).toBeUndefined();
  });
});
