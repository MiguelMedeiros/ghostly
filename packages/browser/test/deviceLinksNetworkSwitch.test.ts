import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newDeviceSetSecret, toBase64Url, type PkarrTransport } from "@ghostly/core";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { createPeerServer } from "../src/devices/peer";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey } from "../src/devices/signingKey";
import { closeDevicesDb, setDeviceMirror } from "../src/devices/store";
import type { EngineServer } from "../src/engine/server";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { DESKTOP_NETWORK, MemoryPkarr } from "../../core/test/support/pairingWorld";
// covers: devices.links.session

/*
 * The network switch on the active device of a device set (WISP 06 § The gate: network off asks nothing of a relay or
 * the DHT). Turned off while the app ran, its links to the other devices went on reading the other device's packet at
 * the relays every 30 s; turned on after a start with it off, they never started, until the app started again.
 */

const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
type Inner = { deviceLinks: { views(): { name: string }[] } | null };
const linksOf = (server: EngineServer) => (server.node as unknown as Inner).deviceLinks?.views().map((view) => view.name) ?? null;

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 500) { await vi.advanceTimersByTimeAsync(500); await new Promise((resolve) => setImmediate(resolve)); }
}
/** Waits for `work` while the fake clock runs: a link's stop waits for its goodbye. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let i = 0; !done && i < 120; i++) await run(500);
  return tracked;
}

let pkarr: MemoryPkarr;
let transport: PkarrTransport;

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates();
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  const turn = new FakeTurnNetwork();
  transport = Object.assign(pkarr.transport(), { turnRead: turn.turnRead.bind(turn), turnPut: turn.turnPut.bind(turn) });
  // This device active in slot 0, a phone (away) in slot 1.
  const own = await createDeviceSigningKey("ghostly");
  const phone = await createDeviceSigningKey("ghostly_phone");
  await putDeviceRecord({
    v: 1, profile: "ghostly", state: "active", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], d: toBase64Url(newDeviceSetSecret()),
    deviceSet: [{ key: toBase64Url(own.publicKey), name: "Desktop" }, { key: toBase64Url(phone.publicKey), name: "Phone" }], ownSlot: 0, activeSlot: 0, signingKey: own.kind,
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetDeviceGates(); });

async function start(): Promise<EngineServer> {
  resetDeviceGates();
  const server = await createPeerServer({ transport, automaticWallets: false }, { gate: await openDeviceGate("ghostly") }) as EngineServer;
  await server.ready;
  await run(30_000);
  return server;
}
async function stop(server: EngineServer): Promise<void> {
  const stopping = server.stop();
  await run(10_000);
  await stopping;
}

describe("the active device's links to its other devices", () => {
  it("stop with the network: nothing is read or published at the relays while it is off", async () => {
    const server = await start();
    expect(linksOf(server)).toEqual(["Phone"]);
    await settled(server.node.updateSettings({ settings: { online: false } }));
    await run(5_000);
    const reads = pkarr.reads, publishes = pkarr.publishes;
    await run(10 * 60_000);
    // Before: 20 reads of the phone's packet (one every 30 s) and 2 publishes in these ten minutes.
    expect({ reads: pkarr.reads - reads, publishes: pkarr.publishes - publishes }).toEqual({ reads: 0, publishes: 0 });
    expect(linksOf(server)).toBeNull();
    // Back on: the link to the phone is there again.
    await settled(server.node.updateSettings({ settings: { online: true } }));
    await run(30_000);
    expect(linksOf(server)).toEqual(["Phone"]);
    await stop(server);
  }, 120_000);

  it("start when the network is turned on after a start with it off", async () => {
    const first = await start();
    await settled(first.node.updateSettings({ settings: { online: false } }));
    await stop(first);
    const server = await start();
    expect(linksOf(server)).toBeNull();
    await settled(server.node.updateSettings({ settings: { online: true } }));
    await run(30_000);
    // Before: none for the whole run, until the app started again.
    expect(linksOf(server)).toEqual(["Phone"]);
    await stop(server);
  }, 120_000);
});
