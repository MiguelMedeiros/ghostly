import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: app.profile-unavailable

/**
 * A profile's database that does not open (reported 2026-10-02: a profile opened once by a build with a newer schema,
 * then by the released app, which drew the chat list from the page's mirror, connected nobody and said nothing).
 * IndexedDB never opens a database below the version it is stored at. `openDb` now says what happened as a
 * `ProfileOpenError`, the engine does not start, and each client is told why instead of being dropped in silence.
 */

/** The module afresh: it keeps its one open (or its failure) for the life of the page. */
async function fresh(name: string) {
  vi.resetModules();
  const idb = await import("../src/shared/idb");
  idb.setDatabaseName(name);
  return idb;
}

/** A database as some build stored it: at `version`, with one record in a store. */
function stored(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      request.transaction!.objectStore("settings").put({ nick: "Kept" }, "settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** What is there now, read without a version: the stored version and the record. */
async function now(name: string): Promise<{ version: number; settings: unknown }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const settings = await new Promise((resolve, reject) => { const r = db.transaction("settings").objectStore("settings").get("settings"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const { version } = db;
  db.close();
  return { version, settings };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("a profile database that does not open", () => {
  it("stored at a higher version than this build reads: the open fails as `newer`, with both versions, and the data is untouched", async () => {
    const idb = await fresh("profile-newer");
    (await stored("profile-newer", idb.DB_VERSION + 1)).close();

    const error = await idb.openDb().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(idb.ProfileOpenError);
    const { failure, message } = error as InstanceType<typeof idb.ProfileOpenError>;
    expect(failure).toMatchObject({ reason: "newer", storedVersion: idb.DB_VERSION + 1, supportedVersion: idb.DB_VERSION });
    expect(message).toBe(`This profile was last used by a newer version of Ghostly (its data is version ${idb.DB_VERSION + 1}, this version reads up to ${idb.DB_VERSION}). Update Ghostly to open it.`);
    // Asked again, the same answer (the store helpers all go through it): no second attempt that could do otherwise.
    await expect(idb.store("settings")).rejects.toBe(error);
    // Never deleted, reset or downgraded: the newer build finds its profile as it left it.
    expect(await now("profile-newer")).toEqual({ version: idb.DB_VERSION + 1, settings: { nick: "Kept" } });
  });

  it("held open at an older version by a window that does not let go: said to be blocked after a wait, instead of pending for good", async () => {
    const idb = await fresh("profile-blocked");
    // A connection of a build that does not close on `versionchange` (ours do).
    const holder = await stored("profile-blocked", idb.DB_VERSION - 1);
    idb.OPEN_TIMINGS.blockedMs = 40;
    const error = await idb.openDb().then(() => null, (e: unknown) => e);
    expect((error as InstanceType<typeof idb.ProfileOpenError>).failure).toMatchObject({ reason: "blocked", supportedVersion: idb.DB_VERSION });
    expect((error as Error).message).toContain("another Ghostly window or tab still has it open with an older version");
    // The other window closes: the upgrade that waited goes through and lets go of its connection, so the next start opens it.
    holder.close();
    await vi.waitFor(async () => { expect((await now("profile-blocked")).version).toBe(idb.DB_VERSION); });
    const again = await fresh("profile-blocked");
    expect((await again.openDb()).version).toBe(again.DB_VERSION);
    expect((await now("profile-blocked")).settings).toEqual({ nick: "Kept" });
  });

  it("no space, storage not allowed, or no reason given: each is said as what it is, with the system's own words", async () => {
    const refusing = (error: unknown, thrown = false) => ({
      open() {
        if (thrown) throw error;
        const request = { error, onerror: null as null | ((event: unknown) => void) };
        queueMicrotask(() => request.onerror?.({ preventDefault() {} }));
        return request;
      },
    });
    const failureWith = async (factory: unknown) => {
      const idb = await fresh("profile-refused");
      vi.stubGlobal("indexedDB", factory);
      const error = await idb.openDb().then(() => null, (e: unknown) => e) as InstanceType<typeof idb.ProfileOpenError>;
      vi.unstubAllGlobals();
      expect(error).toBeInstanceOf(idb.ProfileOpenError);
      return { ...error.failure, message: error.message };
    };

    expect(await failureWith(refusing(new DOMException("The quota has been exceeded.", "QuotaExceededError"))))
      .toMatchObject({ reason: "full", detail: "QuotaExceededError: The quota has been exceeded.", message: "Ghostly could not open this profile's data: this device is out of storage space. Free some space and try again." });
    // Storage blocked for the site throws at once; a private window of an older Firefox answers with InvalidStateError.
    expect(await failureWith(refusing(new DOMException("The operation is insecure.", "SecurityError"), true))).toMatchObject({ reason: "denied" });
    expect(await failureWith(refusing(new DOMException("A mutation operation was attempted on a database that did not allow mutations.", "InvalidStateError")))).toMatchObject({ reason: "denied" });
    expect(await failureWith(undefined)).toMatchObject({ reason: "denied", message: "Ghostly could not open this profile's data: storage is not allowed here (a private window, or storage blocked for this site)." });
    // A damaged database: browsers say UnknownError, and no more.
    expect(await failureWith(refusing(new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError"))))
      .toMatchObject({ reason: "failed", message: "Ghostly could not open this profile's data: UnknownError: Internal error opening backing store for indexedDB.open." });
  });
});

describe("the engine over a profile it cannot open", () => {
  it("does not start: every client is told why in place of a state, every call says so, and nothing reaches the network", async () => {
    const fetched = vi.fn(async () => { throw new TypeError("no network in this test"); });
    vi.stubGlobal("fetch", fetched);
    const idb = await fresh("profile-newer-engine");
    (await stored("profile-newer-engine", idb.DB_VERSION + 1)).close();
    const { EngineServer } = await import("../src/engine/server");
    const server = new EngineServer({ automaticWallets: false });
    await expect(server.ready).rejects.toBeInstanceOf(idb.ProfileOpenError);

    const heard: (EngineEvent | RpcResponse)[] = [];
    const client = { post: (message: EngineEvent | RpcResponse) => { heard.push(message); } };
    server.attach(client);
    await vi.waitFor(() => expect(heard.length).toBe(1));
    expect(heard[0]).toEqual({ kind: "start-failed", failure: { reason: "newer", supportedVersion: idb.DB_VERSION, storedVersion: idb.DB_VERSION + 1, detail: expect.stringContaining("VersionError") } });
    // The failure crosses the extension's port: it must be plain data.
    expect(structuredClone(heard[0])).toEqual(heard[0]);

    // A message typed anyway goes nowhere, and says so.
    await server.handle(client, { kind: "request", id: 7, method: "sendMessage", params: { linkId: "chat", text: "hello" } } as never);
    expect(heard[1]).toMatchObject({ kind: "response", id: 7, error: expect.stringContaining("This profile was last used by a newer version of Ghostly") });
    // A client that comes later (a tab opened after the peer failed) hears the same.
    const late: (EngineEvent | RpcResponse)[] = [];
    server.attach({ post: (message) => { late.push(message); } });
    await vi.waitFor(() => expect(late).toEqual([heard[0]]));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard.filter((message) => message.kind === "state")).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    expect(await now("profile-newer-engine")).toEqual({ version: idb.DB_VERSION + 1, settings: { nick: "Kept" } });
  });
});
