import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceRecordError, DeviceTransitionError, type DeviceRecord } from "../src/devices/state";
import { DEVICES_DB, DEVICES_DB_VERSION, DEVICE_READ_TIMINGS, amendDevice, closeDevicesDb, deviceStateOf, enrollDevice, forgetDevice, moveDevice, readDeviceRecord, setDeviceMirror,
  type DeviceMirror } from "../src/devices/store";
import { putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.gate

/*
 * The device state database (WISP 06 § Durable device state): one record per profile in `ghostly-devices`, every
 * write strict and waited for, the legal changes enforced, and on Desktop a second copy in a file with the stricter
 * of the two believed.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const dropDatabase = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICES_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
/** What is stored, read past the module. */
async function stored(profile: string): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(DEVICES_DB); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    if (!db.objectStoreNames.contains("devices")) return undefined;
    return await new Promise((resolve, reject) => { const r = db.transaction("devices").objectStore("devices").get(profile); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  } finally { db.close(); }
}
const record = (state: DeviceRecord["state"], patch: Partial<DeviceRecord> = {}): DeviceRecord =>
  ({ v: 1, profile: "ghostly", state, saved: 1, turn: 5, rev: 0, deviceSet: [{ key: KEY, name: "MacBook" }], takeovers: 0, earlierSets: [], ...patch });

beforeEach(async () => { setDeviceMirror(null); await closeDevicesDb(); await dropDatabase(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("a profile's device state", () => {
  it("is `single` with no record, for every profile, and reading it writes nothing", async () => {
    expect(await readDeviceRecord("ghostly")).toBeNull();
    expect(await deviceStateOf("ghostly")).toBe("single");
    expect(await deviceStateOf("ghostly_work")).toBe("single");
    // A read never makes the database: a device where nothing was ever enrolled has none.
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
  });

  it("forgetting a profile that has no record makes no database either", async () => {
    await forgetDevice("ghostly");
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
  });

  it("is kept per profile, in a database of its own", async () => {
    await enrollDevice("ghostly_work", "standby", { deviceSet: [{ key: KEY, name: "MacBook" }], turn: 9 });
    expect(await deviceStateOf("ghostly_work")).toBe("standby");
    expect(await deviceStateOf("ghostly")).toBe("single");
    expect(await stored("ghostly_work")).toMatchObject({ profile: "ghostly_work", state: "standby", turn: 9, saved: 1 });
    expect((await indexedDB.databases()).map((d) => [d.name, d.version])).toEqual([[DEVICES_DB, DEVICES_DB_VERSION]]);
  });

  it("changes only as WISP 06 allows, counts each write, and leaves the record alone when a change is refused", async () => {
    await enrollDevice("ghostly", "active", { turn: 5 });
    await moveDevice("ghostly", "releasing", { handoff: { role: "releasing", step: "pass2" } });
    const released = await moveDevice("ghostly", "standby", { releasedTurn: 6 });
    expect(released).toMatchObject({ state: "standby", saved: 3, releasedTurn: 6 });

    await expect(moveDevice("ghostly", "releasing")).rejects.toBeInstanceOf(DeviceTransitionError);
    await expect(enrollDevice("ghostly", "active")).resolves.toMatchObject({ state: "active" });
    await expect(enrollDevice("ghostly", "standby")).rejects.toBeInstanceOf(DeviceTransitionError);
    expect(await stored("ghostly")).toMatchObject({ state: "active", saved: 4 });
    // A profile with no record cannot be moved anywhere but into a device set.
    await expect(moveDevice("ghostly_new", "taking")).rejects.toBeInstanceOf(DeviceTransitionError);
    expect(await stored("ghostly_new")).toBeUndefined();
  });

  it("amends fields without a change of state, and only where there is a record", async () => {
    await enrollDevice("ghostly", "active");
    expect(await amendDevice("ghostly", { rev: 4, seenSequence: 100 })).toMatchObject({ state: "active", rev: 4, seenSequence: 100, saved: 2 });
    await expect(amendDevice("ghostly_none", { rev: 1 })).rejects.toThrow("no device set");
  });

  it("two changes at once apply one after the other", async () => {
    await enrollDevice("ghostly", "active");
    const [a, b] = await Promise.all([amendDevice("ghostly", { rev: 1 }), amendDevice("ghostly", { seenSequence: 7 })]);
    expect([a.saved, b.saved]).toEqual([2, 3]);
    expect(await stored("ghostly")).toMatchObject({ rev: 1, seenSequence: 7, saved: 3 });
  });

  it("is forgotten with the profile", async () => {
    await enrollDevice("ghostly", "standby");
    await forgetDevice("ghostly");
    expect(await deviceStateOf("ghostly")).toBe("single");
  });
});

describe("durability", () => {
  it("every write asks for strict durability and resolves only once the transaction has completed", async () => {
    const asked: (IDBTransactionOptions | undefined)[] = [];
    const completed: string[] = [];
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const tx = real.call(this, names, mode, options);
      if (mode === "readwrite") { asked.push(options); tx.addEventListener("complete", () => completed.push("complete")); }
      return tx;
    });
    await enrollDevice("ghostly", "active");
    expect(completed).toEqual(["complete"]);
    await moveDevice("ghostly", "releasing");
    await amendDevice("ghostly", { rev: 1 });
    await forgetDevice("ghostly");
    expect(asked).toHaveLength(4);
    expect(asked.every((options) => options?.durability === "strict")).toBe(true);
    expect(completed).toHaveLength(4);
  });

  it("a write whose transaction aborts is a failure, never a silent success", async () => {
    await enrollDevice("ghostly", "active");
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const tx = real.call(this, names, mode, options);
      if (mode === "readwrite") queueMicrotask(() => { try { tx.abort(); } catch { /* over */ } });
      return tx;
    });
    await expect(moveDevice("ghostly", "releasing")).rejects.toBeTruthy();
    vi.restoreAllMocks();
    expect(await stored("ghostly")).toMatchObject({ state: "active" });
  });
});

describe("a device where nothing was ever enrolled", () => {
  it("is `single` when the database cannot be made or opened at all (no space, storage that hangs): it is never opened", async () => {
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });
    expect(await deviceStateOf("ghostly")).toBe("single");
    expect(open).not.toHaveBeenCalled();
  });

  it("is `single` when the browser never says which databases exist", async () => {
    vi.spyOn(indexedDB, "databases").mockImplementation(() => new Promise<never>(() => {}));
    const { existsMs } = DEVICE_READ_TIMINGS;
    DEVICE_READ_TIMINGS.existsMs = 40;
    try { expect(await deviceStateOf("ghostly")).toBe("single"); } finally { DEVICE_READ_TIMINGS.existsMs = existsMs; }
  });

  it("is `single` when the browser cannot list databases: an open that would make it is undone", async () => {
    const databases = indexedDB.databases.bind(indexedDB);
    (indexedDB as { databases?: unknown }).databases = undefined;
    try {
      expect(await deviceStateOf("ghostly")).toBe("single");
    } finally { (indexedDB as { databases?: unknown }).databases = databases; }
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
    // And one that exists is found the same way.
    await putDeviceRecord(record("standby"));
    (indexedDB as { databases?: unknown }).databases = undefined;
    try {
      expect(await deviceStateOf("ghostly")).toBe("standby");
    } finally { (indexedDB as { databases?: unknown }).databases = databases; }
  });
});

describe("a device set that cannot be read", () => {
  it("is an error when the database exists and its read never answers", async () => {
    await putDeviceRecord(record("standby"));
    vi.spyOn(indexedDB, "open").mockImplementation(() => ({}) as IDBOpenDBRequest);
    const { readMs } = DEVICE_READ_TIMINGS;
    DEVICE_READ_TIMINGS.readMs = 40;
    try { await expect(deviceStateOf("ghostly")).rejects.toMatchObject({ name: "DeviceReadTimeout" }); } finally { DEVICE_READ_TIMINGS.readMs = readMs; }
  });
});

describe("two pages at once", () => {
  it("a change made on what another page has since changed is refused, and nothing is written over it", async () => {
    await enrollDevice("ghostly", "active");
    // The other page writes between this one's read and its write.
    const mirror: DeviceMirror = { read: async () => null, write: async () => { await putDeviceRecord(record("superseded", { saved: 9 })); } };
    await putDeviceRecord(record("active", { saved: 1 }));
    setDeviceMirror({ read: async () => JSON.stringify(record("active", { saved: 1 })), write: mirror.write });
    await expect(moveDevice("ghostly", "releasing")).rejects.toThrow("changed in another window");
    expect(await stored("ghostly")).toMatchObject({ state: "superseded", saved: 9 });
  });
});

describe("a record that cannot be trusted", () => {
  async function put(value: unknown): Promise<void> {
    await enrollDevice("ghostly_seed", "active");
    await closeDevicesDb();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(DEVICES_DB); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction("devices", "readwrite"); tx.objectStore("devices").put(value); tx.oncomplete = () => resolve(); });
    db.close();
  }

  it("is an error, never `single`: a state this build does not know", async () => {
    await put({ ...record("standby"), state: "paused" });
    await expect(readDeviceRecord("ghostly")).rejects.toBeInstanceOf(DeviceRecordError);
    await expect(deviceStateOf("ghostly")).rejects.toBeInstanceOf(DeviceRecordError);
  });

  it("is an error when a newer build stored the database at a higher version", async () => {
    await closeDevicesDb();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(DEVICES_DB, DEVICES_DB_VERSION + 1); r.onupgradeneeded = () => { r.result.createObjectStore("later"); }; r.onsuccess = () => resolve(r.result); });
    db.close();
    await expect(deviceStateOf("ghostly")).rejects.toMatchObject({ name: "VersionError" });
  });
});

describe("Desktop's file beside the database", () => {
  function fileMirror(): DeviceMirror & { files: Map<string, string>; log: string[] } {
    const files = new Map<string, string>(), log: string[] = [];
    return {
      files, log,
      read: async (profile) => { log.push(`read ${profile}`); return files.get(profile) ?? null; },
      write: async (profile, text) => { log.push(`write ${profile}`); if (text === null) files.delete(profile); else files.set(profile, text); },
    };
  }

  it("gets every write, before the database does", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    const order: string[] = [];
    const write = mirror.write;
    mirror.write = async (profile, text) => { order.push("file"); await write(profile, text); };
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (mode === "readwrite") order.push("database");
      return real.call(this, names, mode, options);
    });
    await enrollDevice("ghostly", "standby");
    expect(order).toEqual(["file", "database"]);
    expect(JSON.parse(mirror.files.get("ghostly")!)).toEqual(await stored("ghostly"));
  });

  it("a file that says standby wins over a database that says active, and the database is brought in line", async () => {
    await putDeviceRecord(record("active", { saved: 8 }));
    const mirror = fileMirror();
    mirror.files.set("ghostly", JSON.stringify(record("standby", { saved: 7 })));
    setDeviceMirror(mirror);
    expect((await readDeviceRecord("ghostly"))?.state).toBe("standby");
    expect(await stored("ghostly")).toMatchObject({ state: "standby", saved: 7 });
  });

  it("a database that says standby wins over a file that says active, and the file is brought in line", async () => {
    await putDeviceRecord(record("standby", { saved: 2 }));
    const mirror = fileMirror();
    mirror.files.set("ghostly", JSON.stringify(record("active", { saved: 9 })));
    setDeviceMirror(mirror);
    expect(await deviceStateOf("ghostly")).toBe("standby");
    expect(JSON.parse(mirror.files.get("ghostly")!)).toMatchObject({ state: "standby", saved: 2 });
  });

  it("a record in the file alone (the WebView's storage was cleared) still stops the engine", async () => {
    const mirror = fileMirror();
    mirror.files.set("ghostly", JSON.stringify(record("superseded")));
    setDeviceMirror(mirror);
    expect(await deviceStateOf("ghostly")).toBe("superseded");
    expect(await stored("ghostly")).toMatchObject({ state: "superseded" });
  });

  it("two copies that agree are read without a write", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    await enrollDevice("ghostly", "standby");
    mirror.log.length = 0;
    expect(await deviceStateOf("ghostly")).toBe("standby");
    expect(mirror.log).toEqual(["read ghostly"]);
  });

  it("a file that is there and is not this profile's record is an error, never `single`", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    mirror.files.set("ghostly", "{not json");
    await expect(deviceStateOf("ghostly")).rejects.toBeTruthy();
    mirror.files.set("ghostly", JSON.stringify({ state: "standby" }));
    await expect(deviceStateOf("ghostly")).rejects.toThrow("not valid");
    mirror.files.set("ghostly", JSON.stringify(record("standby", { profile: "ghostly_other" })));
    await expect(deviceStateOf("ghostly")).rejects.toThrow("another profile");
  });

  it("a file that cannot be reached locks nobody out without evidence of a device set", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    mirror.read = async () => { throw new Error("The app's data folder is unavailable"); };
    // No record in the database: nothing says this profile was ever enrolled.
    expect(await deviceStateOf("ghostly")).toBe("single");
    // A record that stops the engine is believed without the file.
    await putDeviceRecord(record("standby"));
    expect(await deviceStateOf("ghostly")).toBe("standby");
    // An `active` one is not: the file may hold the stricter state.
    await putDeviceRecord(record("active", { saved: 2 }));
    await expect(deviceStateOf("ghostly")).rejects.toThrow("unavailable");
  });

  it("a file read that never answers is the same, after a wait", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    mirror.read = () => new Promise<never>(() => {});
    const { readMs } = DEVICE_READ_TIMINGS;
    DEVICE_READ_TIMINGS.readMs = 40;
    try {
      expect(await deviceStateOf("ghostly")).toBe("single");
      await putDeviceRecord(record("active"));
      await expect(deviceStateOf("ghostly")).rejects.toMatchObject({ name: "DeviceReadTimeout" });
    } finally { DEVICE_READ_TIMINGS.readMs = readMs; }
  });

  it("forgetting a profile removes both copies", async () => {
    const mirror = fileMirror();
    setDeviceMirror(mirror);
    await enrollDevice("ghostly", "standby");
    await forgetDevice("ghostly");
    expect(mirror.files.has("ghostly")).toBe(false);
    expect(await stored("ghostly")).toBeUndefined();
  });
});
