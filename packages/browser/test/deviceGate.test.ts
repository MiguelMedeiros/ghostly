import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcRequest, RpcResponse } from "../src/shared/rpc";
import type { DeviceRecord, StoredDeviceState } from "../src/devices/state";
import type { DeviceLinkEngine, DeviceLinkHost } from "../src/devices/linkOnly";
// covers: devices.gate

/*
 * The gate (WISP 06 § The gate): the device state is read before the engine exists. The web app and Desktop start
 * their peer in `createInPageHost().connect()`; the peer here is a stand-in that counts what a real one would do at
 * its start (open the peer database, start the wallets, publish), so a standby is seen to do none of it.
 */

const fake = vi.hoisted(() => ({ nodes: [] as { options: unknown; started: number; shutdown: ReturnType<typeof vi.fn> }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    started = 0;
    shutdown = vi.fn(async () => {});
    constructor(public events: unknown, public options: unknown) { fake.nodes.push(this as never); }
    // What `GhostlyNode.start()` does first: the peer database (see engine/node.ts).
    async start() { this.started++; (await import("../src/shared/idb")).openDb(); }
    getState() { return { links: [] }; }
    setActiveLink() {}
    appsCloseAll() {}
    echo(params: unknown) { return params; }
  },
}));

const { createInPageHost } = await import("../src/inPageHost");
const { createPeerServer } = await import("../src/devices/peer");
const { openDeviceGate, knownDeviceGate, resetDeviceGates } = await import("../src/devices/gate");
const { DEVICES_DB, DEVICE_READ_TIMINGS, closeDevicesDb, setDeviceMirror } = await import("../src/devices/store");
const { putDeviceRecord, dropDevicesDatabase } = await import("./helpers/deviceRecord");
const { DEVICE_GATED_ERROR, DeviceLinkOnlyServer } = await import("../src/devices/linkOnly");
const { EngineServer } = await import("../src/engine/server");
const { databaseName, setDatabaseName } = await import("../src/shared/idb");

type Posted = EngineEvent | RpcResponse;
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const request = (method: string, params?: unknown, id = 1) => ({ kind: "request", id, method, params }) as unknown as RpcRequest;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const record = (state: StoredDeviceState, patch: Partial<DeviceRecord> = {}): DeviceRecord =>
  ({ v: 1, profile: databaseName(), state, saved: 1, turn: 5, rev: 0, deviceSet: [{ key: KEY, name: "MacBook" }, { key: KEY, name: "Phone" }], activeSlot: 0, ownSlot: 1, d: KEY,
    // A finished enrollment: the record it accepted from the active device (its bytes are not read here).
    turnPacket: KEY, takeovers: 0, earlierSets: [], ...patch });
const host = (onServer = vi.fn()) => ({ onServer, host: createInPageHost({ version: "1.0.3", features: { shareLocalServices: false, openServices: false }, node: { platform: "web" } as never, requestLocalAccess: async () => false, openService: async () => {}, onServer }) });
const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();

let profile = 0;
let opened: string[] = [];
beforeEach(async () => {
  fake.nodes.length = 0;
  resetDeviceGates();
  setDeviceMirror(null);
  await closeDevicesDb();
  await dropDevicesDatabase();
  // A profile of its own per test: nothing a test stored is seen by the next.
  setDatabaseName(`ghostly_gate${++profile}`);
  opened = [];
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => { opened.push(name); return open(name, version); });
});
afterEach(async () => { vi.restoreAllMocks(); await closeDevicesDb(); });

describe("a `single` profile", () => {
  it("starts the engine exactly as before, after one read of the device state", async () => {
    const { host: inPage, onServer } = host();
    const posted: Posted[] = [];
    const connection = await inPage.connect((m) => posted.push(m), () => {});
    await flush();
    expect(fake.nodes).toHaveLength(1);
    expect(fake.nodes[0]).toMatchObject({ options: { platform: "web" }, started: 1 });
    expect(onServer).toHaveBeenCalledTimes(1);
    expect(onServer.mock.calls[0][0]).toBeInstanceOf(EngineServer);
    // No device was ever enrolled here: the device state database does not exist, and is neither opened nor made.
    expect(opened).toEqual([databaseName()]);
    expect(await databases()).not.toContain(DEVICES_DB);
    expect(posted.map((m) => m.kind)).toEqual(["state"]);
    expect(knownDeviceGate()).toEqual({ profile: databaseName(), state: "single", full: true, view: null });

    connection.send(request("echo", "hello"));
    await flush();
    expect(posted.at(-1)).toEqual({ kind: "response", id: 1, result: "hello" });
  });

  it("reads the device state once however many pages connect", async () => {
    const listed = vi.spyOn(indexedDB, "databases");
    const { host: inPage } = host();
    await Promise.all([inPage.connect(() => {}, () => {}), inPage.connect(() => {}, () => {}), openDeviceGate()]);
    await flush();
    expect(fake.nodes).toHaveLength(1);
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it("starts the engine when the device state database could not be made or opened (no space, storage that fails)", async () => {
    vi.restoreAllMocks();
    const open = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => {
      if (name === DEVICES_DB) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return open(name, version);
    });
    const { host: inPage } = host();
    const posted: Posted[] = [];
    await inPage.connect((m) => posted.push(m), () => {});
    await flush();
    expect(fake.nodes).toHaveLength(1);
    expect(fake.nodes[0].started).toBe(1);
    expect(posted.map((m) => m.kind)).toEqual(["state"]);
    expect(knownDeviceGate()).toMatchObject({ state: "single", full: true });
  });

  it("starts the engine when the browser never answers which databases exist, after a short wait", async () => {
    vi.spyOn(indexedDB, "databases").mockImplementation(() => new Promise<never>(() => {}));
    const { existsMs } = DEVICE_READ_TIMINGS;
    DEVICE_READ_TIMINGS.existsMs = 40;
    try {
      const { host: inPage } = host();
      await inPage.connect(() => {}, () => {});
      await flush();
      expect(fake.nodes).toHaveLength(1);
      expect(knownDeviceGate()).toMatchObject({ state: "single", full: true });
    } finally { DEVICE_READ_TIMINGS.existsMs = existsMs; }
  });

  it("says goodbye through the engine when the page closes", async () => {
    const { host: inPage } = host();
    await inPage.connect(() => {}, () => {});
    inPage.announceDeparture();
    expect(fake.nodes[0].shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("the active device", () => {
  it("starts the engine", async () => {
    await putDeviceRecord(record("active"));
    const { host: inPage, onServer } = host();
    await inPage.connect(() => {}, () => {});
    await flush();
    expect(fake.nodes).toHaveLength(1);
    expect(fake.nodes[0].started).toBe(1);
    expect(onServer).toHaveBeenCalledTimes(1);
    expect((await openDeviceGate()).state).toBe("active");
  });
});

describe.each(["standby", "releasing", "taking", "superseded", "moving", "removed"] as const)("a device that is %s", (state) => {
  it("makes no engine, opens no peer database, and tells the page its state", async () => {
    await putDeviceRecord(record(state));
    opened = [];
    const { host: inPage, onServer } = host();
    const posted: Posted[] = [];
    const connection = await inPage.connect((m) => posted.push(m), () => {});
    // A `releasing` device whose pass 2 cannot run here (no handoff host in this test) never signed a release: it is
    // the active device again, and the pages start again into the gate (part 5). That second word comes once `active`
    // is written, a read and a write later: waited for, not a fixed pause (5 ms was short on a busy CI runner).
    const gates = [{ kind: "device-gate", gate: { state, activeDevice: "MacBook" } }, ...(state === "releasing" ? [{ kind: "device-gate", gate: { state: "releasing", reload: true } }] : [])];
    await vi.waitFor(() => expect(posted).toEqual(gates), { timeout: 10_000 });
    await flush();

    expect(fake.nodes).toHaveLength(0);
    expect(onServer).not.toHaveBeenCalled();
    expect(opened).not.toContain(databaseName());
    expect(await databases()).not.toContain(databaseName());
    expect(posted).toEqual(gates);
    if (state === "releasing") {
      const { readDeviceRecord } = await import("../src/devices/store");
      expect((await readDeviceRecord(databaseName()))?.state).toBe("active");
    }
    // Nothing of the device set's secret or keys reaches a page.
    expect(JSON.stringify(posted)).not.toContain(KEY);

    // Every engine call is refused: nothing is sent, paid or published from here.
    connection.send(request("sendMessage", { linkId: "a", text: "hello" }, 7));
    connection.send(request("walletPay", {}, 8));
    connection.send(request("peekProfile", { profile: "x", dbName: "ghostly_x" }, 9));
    await vi.waitFor(() => expect(posted.slice(gates.length)).toEqual([7, 8, 9].map((id) => ({ kind: "response", id, error: DEVICE_GATED_ERROR }))), { timeout: 10_000 });
    expect(fake.nodes).toHaveLength(0);
    expect(await databases()).not.toContain(databaseName());

    // Closing the page has nothing to say goodbye to, and must not throw.
    expect(() => inPage.announceDeparture()).not.toThrow();
  });
});

describe("a device state that cannot be read", () => {
  it("starts nothing and says why, when a device set is there: it is never taken for `single`", async () => {
    await putDeviceRecord(record("standby"));
    await closeDevicesDb();
    vi.restoreAllMocks();
    vi.spyOn(indexedDB, "open").mockImplementation((name: string) => {
      if (name !== DEVICES_DB) throw new Error(`${name} must not be opened`);
      throw new DOMException("The operation failed for reasons unrelated to the database itself.", "UnknownError");
    });
    const { host: inPage } = host();
    const posted: Posted[] = [];
    await inPage.connect((m) => posted.push(m), () => {});
    await flush();
    expect(fake.nodes).toHaveLength(0);
    expect(posted).toEqual([{ kind: "device-gate", gate: { state: "unreadable", detail: expect.stringContaining("UnknownError") } }]);
    expect(knownDeviceGate()).toMatchObject({ state: "unreadable", full: false });
  });

  it("starts nothing when the stored record is one this build cannot read", async () => {
    await putDeviceRecord(record("standby"));
    await closeDevicesDb();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(DEVICES_DB); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction("devices", "readwrite"); tx.objectStore("devices").put({ ...record("standby"), v: 2 }); tx.oncomplete = () => resolve(); });
    db.close();
    expect(await openDeviceGate()).toMatchObject({ state: "unreadable", full: false });
    expect((await createPeerServer({})).gated).toBe(true);
    expect(fake.nodes).toHaveLength(0);
  });
});

describe("Desktop", () => {
  it("is stopped by the fsynced file alone, when the WebView's database has no record", async () => {
    const files = new Map([[databaseName(), JSON.stringify(record("standby"))]]);
    setDeviceMirror({ read: async (p) => files.get(p) ?? null, write: async (p, text) => { if (text === null) files.delete(p); else files.set(p, text); } });
    const { host: inPage } = host();
    const posted: Posted[] = [];
    await inPage.connect((m) => posted.push(m), () => {});
    await flush();
    expect(fake.nodes).toHaveLength(0);
    expect(posted).toEqual([{ kind: "device-gate", gate: { state: "standby", activeDevice: "MacBook" } }]);
    expect(opened).not.toContain(databaseName());
  });

  it("is stopped when the file cannot be read and the database says this is the active device", async () => {
    await putDeviceRecord(record("active"));
    setDeviceMirror({ read: async () => { throw new Error("The device state could not be read: Input/output error"); }, write: async () => {} });
    expect(await openDeviceGate()).toMatchObject({ state: "unreadable", full: false, view: { detail: expect.stringContaining("Input/output error") } });
  });

  it("starts the engine when the file cannot be reached and nothing says the profile was ever enrolled", async () => {
    setDeviceMirror({ read: async () => { throw new Error("The app's data folder is unavailable"); }, write: async () => {} });
    const { host: inPage } = host();
    await inPage.connect(() => {}, () => {});
    await flush();
    expect(fake.nodes).toHaveLength(1);
    expect(knownDeviceGate()).toMatchObject({ state: "single", full: true });
  });
});

describe("device-link-only mode", () => {
  /** A stand-in for the small engine later parts of WISP 06 bring: the turn record and the device links. */
  function standbyEngine(): DeviceLinkEngine & { host?: DeviceLinkHost; calls: [string, unknown][]; stopped: number } {
    const double = {
      calls: [] as [string, unknown][], stopped: 0, host: undefined as DeviceLinkHost | undefined,
      start: async (h: DeviceLinkHost) => { double.host = h; },
      stop: async () => { double.stopped++; },
      call: async (method: string, params: unknown) => { double.calls.push([method, params]); return { turn: 6 }; },
    };
    return double;
  }

  it("is what `createPeerServer` gives a standby, and the engine is what it gives the active device", async () => {
    await putDeviceRecord(record("standby"));
    expect(await createPeerServer({})).toBeInstanceOf(DeviceLinkOnlyServer);
    resetDeviceGates();
    await putDeviceRecord(record("active", { saved: 2 }));
    expect(await createPeerServer({})).toBeInstanceOf(EngineServer);
  });

  it("is started with the gate, hands `device…` calls to its engine and refuses the rest", async () => {
    await putDeviceRecord(record("standby"));
    const engine = standbyEngine();
    const server = await createPeerServer({}, { standby: engine });
    await server.ready;
    expect(engine.host?.gate).toMatchObject({ state: "standby", full: false });

    const posted: Posted[] = [];
    const client = { post: (m: Posted) => void posted.push(m) };
    server.attach(client);
    await server.handle(client, request("deviceReadTurn", { fresh: true }, 1));
    await server.handle(client, request("exportLinks", undefined, 2));
    expect(engine.calls).toEqual([["deviceReadTurn", { fresh: true }]]);
    expect(posted.slice(1)).toEqual([{ kind: "response", id: 1, result: { turn: 6 } }, { kind: "response", id: 2, error: DEVICE_GATED_ERROR }]);

    // What the screen shows can change while it is open (a turn read): every page hears it, a late one gets the latest.
    engine.host!.show({ state: "standby", activeDevice: "Phone" });
    expect(posted.at(-1)).toEqual({ kind: "device-gate", gate: { state: "standby", activeDevice: "Phone" } });
    const late: Posted[] = [];
    server.attach({ post: (m) => void late.push(m) });
    expect(late).toEqual([{ kind: "device-gate", gate: { state: "standby", activeDevice: "Phone" } }]);

    await server.stop();
    expect(engine.stopped).toBe(1);
  });

  it("in this version runs nothing and has nothing to call", async () => {
    await putDeviceRecord(record("standby"));
    const server = await createPeerServer({});
    await expect(server.ready).resolves.toBeUndefined();
    const posted: Posted[] = [];
    const client = { post: (m: Posted) => void posted.push(m) };
    await server.handle(client, request("deviceReadTurn", undefined, 3));
    expect(posted).toEqual([{ kind: "response", id: 3, error: `${DEVICE_GATED_ERROR} (deviceReadTurn is not available yet)` }]);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("cannot be made for a device that may run the engine", async () => {
    const gate = await openDeviceGate();
    expect(() => new DeviceLinkOnlyServer(gate)).toThrow("not active");
  });
});
