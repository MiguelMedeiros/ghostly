import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { identityFromSeed, sign, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import type { DeviceRecord } from "../src/devices/state";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.takeover, devices.gate

/*
 * The active device reads the turn before its engine starts (WISP 06 § When a device checks, § Failure cases: "Forced
 * takeover while the old device is off; it comes back: it reads the higher turn at start, before the engine starts,
 * and becomes superseded without publishing"). The engine here is a stand-in that counts its starts.
 */

const fake = vi.hoisted(() => ({ nodes: [] as { options: { limited?: boolean } ; started: number }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    started = 0;
    shutdown = vi.fn(async () => {});
    constructor(public events: unknown, public options: { limited?: boolean }) { fake.nodes.push(this as never); }
    async start() { this.started++; }
    getState() { return { links: [] }; }
  },
}));

const { createPeerServer } = await import("../src/devices/peer");
const { knownDeviceGate, resetDeviceGates } = await import("../src/devices/gate");
const { closeDevicesDb, readDeviceRecord, setDeviceMirror } = await import("../src/devices/store");
const { putDeviceRecord, dropDevicesDatabase } = await import("./helpers/deviceRecord");
const { DeviceLinkOnlyServer } = await import("../src/devices/linkOnly");
const { EngineServer } = await import("../src/engine/server");
const { databaseName, setDatabaseName } = await import("../src/shared/idb");
const { createDeviceSigningKey } = await import("../src/devices/signingKey");

const D = new Uint8Array(32).fill(0x6a);
const keys = turnKeys(D);
const phone = identityFromSeed(new Uint8Array(32).fill(0x61));
const N = 4_000;

let n = 0;
beforeEach(async () => {
  fake.nodes.length = 0;
  resetDeviceGates();
  setDeviceMirror(null);
  await closeDevicesDb();
  await dropDevicesDatabase();
  setDatabaseName(`ghostly_start${++n}`);
});

/** This device, active in slot 0, with its own record of turn `N` stored; the phone in slot 1. */
async function activeDesktop(): Promise<{ stored: Uint8Array }> {
  const key = await createDeviceSigningKey(databaseName(), { forceSeed: true });
  const slots = [{ key: key.publicKey, name: "Desktop" }, { key: phone.publicKey, name: "Phone" }, null, null];
  const stored = await signTurnPacket(keys, { turn: N, rev: 0, author: 0, active: 0, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => key.sign(bytes));
  const record: DeviceRecord = {
    v: 1, profile: databaseName(), state: "active", saved: 1, turn: N, rev: 0, d: toBase64Url(D), ownSlot: 0, activeSlot: 0, signingKey: key.kind,
    deviceSet: [{ key: toBase64Url(key.publicKey), name: "Desktop" }, { key: toBase64Url(phone.publicKey), name: "Phone" }],
    turnPacket: toBase64Url(stored), takeovers: 0, earlierSets: [],
  };
  await putDeviceRecord(record);
  return { stored };
}

describe("the active device's read before its engine starts", () => {
  it("another device took the turn while it was off: it is superseded, keeps its copy, and no engine is made", async () => {
    const network = new FakeTurnNetwork();
    await activeDesktop();
    const slots = [{ key: (await createDeviceSigningKey(databaseName())).publicKey, name: "Desktop" }, { key: phone.publicKey, name: "Phone" }, null, null];
    network.seed(await signTurnPacket(keys, { turn: N + 1, rev: 0, author: 1, active: 1, slots, instance: new Uint8Array(8).fill(2) }, (bytes) => sign(bytes, phone.seed)));
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(DeviceLinkOnlyServer);
    expect(fake.nodes).toEqual([]);
    expect(knownDeviceGate()).toMatchObject({ state: "superseded", full: false, view: { state: "superseded", activeDevice: "Phone" } });
    expect(await readDeviceRecord(databaseName())).toMatchObject({ state: "superseded", copy: "frozen", activeSlot: 1 });
    // Nothing was put: a replaced device publishes nothing more.
    expect(network.puts()).toEqual([]);
    await server.stop();
  });

  it("its own record: it writes its next one and the whole engine starts", async () => {
    const network = new FakeTurnNetwork();
    const { stored } = await activeDesktop();
    network.seed(stored);
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(EngineServer);
    expect(fake.nodes.map((node) => node.options.limited)).toEqual([undefined]);
    expect((await readDeviceRecord(databaseName()))?.rev).toBe(1);
  });

  it("no source answers: the engine starts in limited mode, which publishes, dials and settles nothing", async () => {
    const network = new FakeTurnNetwork();
    await activeDesktop();
    for (const source of network.sources) source.down = true;
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(EngineServer);
    expect(fake.nodes.map((node) => node.options.limited)).toEqual([true]);
    expect((await readDeviceRecord(databaseName()))?.state).toBe("active");
  });

  it("an enrollment whose record was put and whose write was lost is taken back first, not read as a clone", async () => {
    const network = new FakeTurnNetwork();
    const key = await createDeviceSigningKey(databaseName(), { forceSeed: true });
    const alone = [{ key: key.publicKey, name: "Desktop" }, null, null, null];
    const stored = await signTurnPacket(keys, { turn: N, rev: 0, author: 0, active: 0, slots: alone, instance: new Uint8Array(8).fill(1) }, (bytes) => key.sign(bytes));
    // The record listing the phone went out; the write that stored it here did not land (a crash between the two).
    const withPhone = [{ key: key.publicKey, name: "Desktop" }, { key: phone.publicKey, name: "Phone" }, null, null];
    network.seed(await signTurnPacket(keys, { turn: N, rev: 1, author: 0, active: 0, slots: withPhone, instance: new Uint8Array(8).fill(1) }, (bytes) => key.sign(bytes)));
    await putDeviceRecord({
      v: 1, profile: databaseName(), state: "active", saved: 1, turn: N, rev: 0, d: toBase64Url(D), ownSlot: 0, activeSlot: 0, signingKey: key.kind,
      deviceSet: [{ key: toBase64Url(key.publicKey), name: "Desktop" }], turnPacket: toBase64Url(stored), takeovers: 0, earlierSets: [],
      unfinishedGrants: [{ key: toBase64Url(phone.publicKey), name: "Phone", at: 1 }],
    } satisfies DeviceRecord);
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(EngineServer);
    const after = await readDeviceRecord(databaseName());
    expect(after?.state).toBe("active");
    expect(after?.deviceSet.flatMap((slot) => (slot ? [slot.name] : []))).toEqual(["Desktop", "Phone"]);
    expect(after?.unfinishedGrants).toEqual([]);
  });

  it("a read that fails (its signing key is gone) starts nothing but limited mode: it fails closed", async () => {
    const network = new FakeTurnNetwork();
    await putDeviceRecord({ v: 1, profile: databaseName(), state: "active", saved: 1, turn: N, rev: 0, d: toBase64Url(D), ownSlot: 0, activeSlot: 0,
      deviceSet: [{ key: toBase64Url(phone.publicKey), name: "Desktop" }], takeovers: 0, earlierSets: [] } satisfies DeviceRecord);
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(EngineServer);
    expect(fake.nodes.map((node) => node.options.limited)).toEqual([true]);
  });

  it("a profile with no device set reads nothing and starts as before", async () => {
    const network = new FakeTurnNetwork();
    const server = await createPeerServer({}, { turn: network });
    expect(server).toBeInstanceOf(EngineServer);
    expect(network.calls).toEqual([]);
  });
});
