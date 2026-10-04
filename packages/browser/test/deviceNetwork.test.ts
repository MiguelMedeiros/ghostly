import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, toBase64Url, type PkarrTransport } from "@ghostly/core";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { DeviceLinkOnlyServer } from "../src/devices/linkOnly";
import { deviceNetworkOf, saveDeviceNetwork, standbyNetwork } from "../src/devices/network";
import { createPeerServer, standbyEngine } from "../src/devices/peer";
import { NATIVE_RETRY_MAX_MS, NATIVE_RETRY_MS } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceNetwork } from "../src/devices/state";
import { DEVICES_DB, closeDevicesDb, enrollDevice, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { firstDeviceSet } from "../src/devices/setup";
import { EngineServer } from "../src/engine/server";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr } from "../../core/test/support/pairingWorld";
// covers: devices.links.session, devices.gate

/*
 * A standby's network settings (WISP 06 § The gate): the active device keeps a copy of the person's relays, Iroh
 * relays, ICE servers and "network off" in the device record, and device-link-only mode, which never opens the
 * profile's database, goes by that copy. Every key and secret here is made in the test.
 */

const iroh = vi.hoisted(() => ({ relays: [] as string[][] }));
vi.mock("../src/platform/irohWeb", async (original) => ({
  ...(await original<typeof import("../src/platform/irohWeb")>()),
  createIrohWebEndpoint: async (_seed: string, options: { relays?: string[] } = {}) => { iroh.relays.push(options.relays ?? []); throw new Error("No Iroh in this test"); },
}));

const hyper = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../src/platform/hyperdhtRelay", async (original) => ({
  ...(await original<typeof import("../src/platform/hyperdhtRelay")>()),
  createRelayedHyperEndpoint: async (_seed: string, url: string) => { hyper.urls.push(url); throw new Error("No HyperDHT relay in this test"); },
}));

/** Waits for `condition` while the fake clock runs, giving real turns of the loop too (a factory's module loads in one). */
async function waitFor(condition: () => boolean): Promise<void> {
  // At least 300 turns, and on a busy machine as long as 15 real seconds: a module that loads late is not a failure.
  const until = performance.now() + 15_000;
  for (let i = 0; !condition() && (i < 300 || performance.now() < until); i++) { await vi.advanceTimersByTimeAsync(10); await new Promise((resolve) => setImmediate(resolve)); }
}

const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
const NETWORK: DeviceNetwork = {
  relays: ["https://relay.person.test"], readRelays: true, irohRelays: ["https://iroh.person.test"], hyperdhtRelay: "wss://hyperdht.person.test",
  iceServers: [{ urls: "turn:turn.person.test:3478", username: "person", credential: "test-credential" }],
};

/** A standby's record: this device in slot 1, the active one in slot 0, and the copy of the network settings. */
async function standbyRecord(network?: DeviceNetwork): Promise<void> {
  const own = await createDeviceSigningKey("ghostly");
  const other = await createDeviceSigningKey("ghostly_other");
  await putDeviceRecord({
    v: 1, profile: "ghostly", state: "standby", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], d: toBase64Url(newDeviceSetSecret()),
    deviceSet: [{ key: toBase64Url(other.publicKey), name: "Desktop" }, { key: toBase64Url(own.publicKey), name: "Phone" }], ownSlot: 1, activeSlot: 0,
    signingKey: own.kind, ...(network ? { network } : {}),
  });
}

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates(); iroh.relays.length = 0; hyper.urls.length = 0;
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the copy of the network settings", () => {
  it("holds the relays, the Iroh relays, the HyperDHT relay, the ICE servers and network off, and nothing else of the settings", () => {
    expect(deviceNetworkOf({ online: true, relays: [], iceServers: [] })).toEqual({});
    expect(deviceNetworkOf({ online: false, ...NETWORK } as never)).toEqual({ off: true, ...NETWORK });
    expect(deviceNetworkOf({ online: true, relays: ["https://a.test"], readRelays: false, iceServers: [] })).toEqual({ relays: ["https://a.test"] });
    expect(deviceNetworkOf({ online: true, relays: [], iceServers: [], hyperdhtRelay: " " })).toEqual({});
  });

  it("is written into the record of a profile with a device set, only when it changed, and never for one with none", async () => {
    expect(await saveDeviceNetwork("ghostly", { online: true, relays: ["https://a.test"], iceServers: [] })).toBeNull();
    expect((await indexedDB.databases()).map((db) => db.name)).toEqual([]);
    await enrollDevice("ghostly", "active", await firstDeviceSet("ghostly", newDeviceSetSecret(), "MacBook"));
    const written = (await saveDeviceNetwork("ghostly", { online: false, ...NETWORK } as never))!;
    expect(written.network).toEqual({ off: true, ...NETWORK });
    const again = (await saveDeviceNetwork("ghostly", { online: false, ...NETWORK } as never))!;
    expect(again.saved).toBe(written.saved);
    expect((await saveDeviceNetwork("ghostly", { online: true, relays: [], iceServers: [] }))!.network).toEqual({});
  });

  it("is refused in a record when it is not one", async () => {
    await putDeviceRecord({ v: 1, profile: "ghostly", state: "standby", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [], network: { relays: "https://a.test" } });
    await expect(readDeviceRecord("ghostly")).rejects.toThrow("network");
  });
});

describe("a standby's network", () => {
  it("goes through the person's relays, tells a transport of the host's own, and builds its connections with the person's ICE servers", () => {
    const own = standbyNetwork(NETWORK);
    expect(own.off).toBe(false);
    expect(own.transport.describe().relays).toEqual(NETWORK.relays);
    expect(own.irohRelays).toEqual(NETWORK.irohRelays);
    const configure = vi.fn();
    const given = { configure } as unknown as PkarrTransport;
    expect(standbyNetwork(NETWORK, given).transport).toBe(given);
    expect(configure).toHaveBeenCalledWith({ relays: NETWORK.relays, readRelays: true });
    const configs: RTCConfiguration[] = [];
    vi.stubGlobal("RTCPeerConnection", function RTCPeerConnection(config: RTCConfiguration) { configs.push(config); return {}; });
    standbyNetwork(NETWORK).createPeerConnection!();
    expect(configs[0].iceServers).toContainEqual(NETWORK.iceServers![0]);
    // No copy (a record from before it was kept): the app's defaults.
    const defaults = standbyNetwork(undefined);
    expect(defaults.transport.describe().relays.length).toBeGreaterThan(0);
    expect(defaults.irohRelays).toBeUndefined();
  });

  it("homes the links' Iroh endpoints on the person's Iroh relays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await standbyRecord(NETWORK);
      const gate = await openDeviceGate("ghostly");
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const engine = (await standbyEngine(gate, { transport: pkarr.transport(), irohWeb: true, pollIntervals: RELAY_POLL_INTERVALS }))!;
      await engine.start({ gate, show: () => {} });
      await waitFor(() => !!iroh.relays.length && !!hyper.urls.length);
      expect(iroh.relays).toEqual([NETWORK.irohRelays]);
      const stopping = engine.stop();
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(100);
      await stopping;
    } finally { vi.useRealTimers(); }
  });

  it("offers HyperDHT on the links through the person's HyperDHT relay where the host runs none, starting it again when the relay did not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await standbyRecord(NETWORK);
      const gate = await openDeviceGate("ghostly");
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const engine = (await standbyEngine(gate, { transport: pkarr.transport(), irohWeb: true, pollIntervals: RELAY_POLL_INTERVALS }))!;
      await engine.start({ gate, show: () => {} });
      await waitFor(() => !!hyper.urls.length && !!iroh.relays.length);
      // Counted, not matched exactly: the links may start once more while the standby settles (CI timing).
      expect(new Set(hyper.urls)).toEqual(new Set([NETWORK.hyperdhtRelay]));
      const first = { hyper: hyper.urls.length, iroh: iroh.relays.length };
      // Neither the relay nor Iroh answered: both are started again in a while, not given up for the life of the link.
      await vi.advanceTimersByTimeAsync(NATIVE_RETRY_MS);
      await waitFor(() => hyper.urls.length > first.hyper && iroh.relays.length > first.iroh);
      expect(hyper.urls.length).toBeGreaterThan(first.hyper);
      expect(iroh.relays.length).toBeGreaterThan(first.iroh);
      expect(new Set(hyper.urls)).toEqual(new Set([NETWORK.hyperdhtRelay]));
      const stopping = engine.stop();
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(100);
      await stopping;
      // Stopped: nothing more is started.
      const stoppedAt = hyper.urls.length;
      await vi.advanceTimersByTimeAsync(NATIVE_RETRY_MAX_MS * 2);
      expect(hyper.urls.length).toBe(stoppedAt);
    } finally { vi.useRealTimers(); }
  });

  it("leaves HyperDHT to the host where it runs its own (the Desktop)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await standbyRecord(NETWORK);
      const gate = await openDeviceGate("ghostly");
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const own: string[] = [];
      const engine = (await standbyEngine(gate, {
        transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS,
        nativeTransports: { "hyperdht/1": async (seed: string) => { own.push(seed); throw new Error("No HyperDHT in this test"); } },
      }))!;
      await engine.start({ gate, show: () => {} });
      await waitFor(() => !!own.length);
      expect(own.length).toBe(1);
      expect(hyper.urls).toEqual([]);
      const stopping = engine.stop();
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(100);
      await stopping;
    } finally { vi.useRealTimers(); }
  });

  it("homes a Desktop's own Iroh on the person's Iroh relays, where the host takes them", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await standbyRecord(NETWORK);
      const gate = await openDeviceGate("ghostly");
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const given: unknown[] = [];
      const engine = (await standbyEngine(gate, {
        transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, nativeIrohRelays: true,
        nativeTransports: { "iroh/1": async (_seed: string, options?: { relays?: string[] }) => { given.push(options); throw new Error("No Iroh in this test"); } },
      }))!;
      await engine.start({ gate, show: () => {} });
      await waitFor(() => !!given.length);
      // Every start (one, or one more while the standby settles) gets the record's relays.
      for (const options of given) expect(options).toEqual({ relays: NETWORK.irohRelays });
      const stopping = engine.stop();
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(100);
      await stopping;
    } finally { vi.useRealTimers(); }
  });

  it("asks nothing of anyone with the network off: no relay, no DHT, no link, no turn read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await standbyRecord({ ...NETWORK, off: true });
      const gate = await openDeviceGate("ghostly");
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const fetches = vi.spyOn(globalThis, "fetch");
      const server = await createPeerServer({ transport: pkarr.transport(), irohWeb: true }, { gate });
      expect(server).toBeInstanceOf(DeviceLinkOnlyServer);
      await server.ready;
      const answers: { id: number; result?: unknown; error?: string }[] = [];
      const page = { post: (message: unknown) => { const m = message as { kind: string; id: number }; if (m.kind === "response") answers.push(m as never); } };
      server.attach(page);
      await server.handle(page, { kind: "request", id: 1, method: "deviceLinks" } as never);
      await server.handle(page, { kind: "request", id: 2, method: "deviceTurnCheck" } as never);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(answers.find((a) => a.id === 1)!.result).toEqual([]);
      expect(answers.find((a) => a.id === 2)!.result).toBeNull();
      expect(pkarr.reads + pkarr.publishes).toBe(0);
      expect(fetches).not.toHaveBeenCalled();
      expect(iroh.relays).toEqual([]);
      await server.stop();
    } finally { vi.useRealTimers(); }
  });
});

describe("the active device's engine", () => {
  it("copies a change of the network settings into the device record, and makes none for a profile with no device set", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    // A profile with no device set first: a change of settings reads and writes no device state.
    let gate = await openDeviceGate("ghostly");
    expect(gate.state).toBe("single");
    let server = await createPeerServer({ transport: pkarr.transport(), automaticWallets: false }, { gate }) as EngineServer;
    await server.ready;
    await server.node.updateSettings({ settings: { iceServers: NETWORK.iceServers } });
    await server.stop();
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(DEVICES_DB);

    // The same profile with a device set, active here.
    await enrollDevice("ghostly", "active", await firstDeviceSet("ghostly", newDeviceSetSecret(), "MacBook"));
    resetDeviceGates();
    gate = await openDeviceGate("ghostly");
    expect(gate.state).toBe("active");
    server = await createPeerServer({ transport: pkarr.transport(), automaticWallets: false }, { gate }) as EngineServer;
    await server.ready;
    await server.node.updateSettings({ settings: { irohRelays: NETWORK.irohRelays, iceServers: NETWORK.iceServers } });
    expect((await readDeviceRecord("ghostly"))!.network).toMatchObject({ irohRelays: NETWORK.irohRelays, iceServers: NETWORK.iceServers });
    await server.node.updateSettings({ settings: { online: false } });
    expect((await readDeviceRecord("ghostly"))!.network).toMatchObject({ off: true });
    // A change of something else writes nothing.
    const saved = (await readDeviceRecord("ghostly"))!.saved;
    await server.node.updateSettings({ settings: { nick: "Miguel" } });
    expect((await readDeviceRecord("ghostly"))!.saved).toBe(saved);
    // The hook enrollment calls writes what the settings are now.
    await server.node.syncDeviceNetwork();
    expect((await readDeviceRecord("ghostly"))!.network).toMatchObject({ off: true, irohRelays: NETWORK.irohRelays });
    await server.stop();
  });
});
