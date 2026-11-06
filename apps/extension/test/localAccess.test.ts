import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorld } from "./fakeChrome";
import { webLocalFetch, type LocalFetch } from "@ghostly/core";
import { resetEngine } from "./fakeEngine";
import { bootExtension, engine, useProfile } from "./extension";

// covers: services.add, services.stop, app.clear-data, profiles.delete

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
vi.mock("../../ui/src/lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/**
 * Chrome's optional host permission for a shared local app is per host (`http://127.0.0.1/*`, every port), and the
 * extension's profiles all hold the same ones. Removing the last app at a host, in every profile, gives it back.
 */

const WORK = "work000000";
const DATABASES = ["ghostly", `ghostly_${WORK}`];

let world: FakeWorld;

/** A profile's peer database with these apps shared, as the engine keeps them (`services`, by id). */
async function shareIn(dbName: string, ...targets: string[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("services")) request.result.createObjectStore("services", { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("services", "readwrite");
    targets.forEach((target, i) => tx.objectStore("services").put({ id: `app${i}-${target}`, name: `app ${i}`, target, enabled: true, createdAt: 0 }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** What the engine does on `removeService` / `clearProfileData`: the app's row goes from the profile's database. */
async function unshareIn(dbName: string, target?: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const store = db.transaction("services", "readwrite").objectStore("services");
    const all = store.getAll();
    all.onsuccess = () => {
      for (const row of all.result as { id: string; target: string }[]) if (target === undefined || row.target === target) store.delete(row.id);
    };
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
  db.close();
}

const drop = (name: string) => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
const host = async () => (await world.load("page", () => import("../src/host.ts"))).extensionHost;

/** Chrome's prompt said yes to these patterns, as the Services page asks for them when an app is shared. */
async function granted(...patterns: string[]): Promise<void> {
  const extensionHost = await host();
  for (const pattern of patterns) expect(await extensionHost.requestLocalAccess(pattern, pattern.replace("/*", ":3400"))).toBe(true);
}

beforeEach(async () => {
  resetEngine();
  for (const name of DATABASES) await drop(name);
  world = await bootExtension();
  useProfile(world, "", [WORK]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("removing the last app at a local address", () => {
  it("gives Chrome back the host's pattern once no app is left at that host", async () => {
    await granted("http://127.0.0.1/*");
    await shareIn("ghostly", "http://127.0.0.1:3400");
    await unshareIn("ghostly", "http://127.0.0.1:3400");
    await (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    expect(world.callsTo("permissions.remove")).toEqual([[{ origins: ["http://127.0.0.1/*"] }]]);
    expect([...world.hostAccess]).toEqual([]);
  });

  it("keeps it while another app of the profile is at the same host on another port", async () => {
    await granted("http://127.0.0.1/*");
    await shareIn("ghostly", "http://127.0.0.1:3400", "http://127.0.0.1:5000/notes");
    await unshareIn("ghostly", "http://127.0.0.1:3400");
    await (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    expect(world.callsTo("permissions.remove")).toEqual([]);
    expect([...world.hostAccess]).toEqual(["http://127.0.0.1/*"]);
  });

  it("keeps it while another profile shares an app at that host, which holds the same permission", async () => {
    await granted("http://127.0.0.1/*");
    await shareIn("ghostly", "http://127.0.0.1:3400");
    await shareIn(`ghostly_${WORK}`, "http://127.0.0.1:8080");
    await unshareIn("ghostly", "http://127.0.0.1:3400");
    await (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    expect([...world.hostAccess]).toEqual(["http://127.0.0.1/*"]);
    // Once that one goes too, from the other profile, nothing needs it.
    await unshareIn(`ghostly_${WORK}`);
    await (await host()).forgetLocalAccess!("http://127.0.0.1:8080");
    expect([...world.hostAccess]).toEqual([]);
  });

  it("takes each host as its own pattern: localhost, 127.0.0.1 and [::1], http and https", async () => {
    await granted("http://localhost/*", "http://[::1]/*", "https://localhost/*", "http://127.0.0.1/*");
    // An app at 127.0.0.1 or over https keeps its own pattern, not localhost's over http.
    await shareIn("ghostly", "http://localhost:3400", "http://[::1]:3400", "https://localhost:8443", "http://127.0.0.1:3400");
    await unshareIn("ghostly", "http://localhost:3400");
    await unshareIn("ghostly", "http://[::1]:3400");
    const extensionHost = await host();
    await extensionHost.forgetLocalAccess!("http://localhost:3400");
    await extensionHost.forgetLocalAccess!("http://[::1]:3400");
    expect(world.callsTo("permissions.remove")).toEqual([[{ origins: ["http://localhost/*"] }], [{ origins: ["http://[::1]/*"] }]]);
    expect([...world.hostAccess].sort()).toEqual(["http://127.0.0.1/*", "https://localhost/*"]);
  });

  it("keeps it when a profile's apps could not be read", async () => {
    await granted("http://127.0.0.1/*");
    vi.spyOn(indexedDB, "databases").mockRejectedValue(new Error("refused"));
    await (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    expect(world.callsTo("permissions.remove")).toEqual([]);
    expect([...world.hostAccess]).toEqual(["http://127.0.0.1/*"]);
  });
});

describe("a contact's request to a shared local app", () => {
  let fetched: string[];
  beforeEach(() => {
    fetched = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(String(url)); return new Response("ok"); });
  });

  /**
   * What the offscreen peer reaches the app with, in the offscreen document (which has `chrome.runtime` alone): the
   * `localFetch` it gave the engine, or the engine's own.
   */
  const reach = (url: string) => world.within("offscreen", () => ((engine().options as { localFetch?: LocalFetch }).localFetch ?? webLocalFetch)({ url, method: "GET", headers: [], body: null, signal: new AbortController().signal }));

  it("is refused for an app that came with a restored profile, though Chrome holds its host for another profile", async () => {
    // Another profile shares an app at localhost:8080: Chrome's permission for localhost is every port's, every profile's.
    world.hostAccess.add("http://localhost/*");
    await shareIn("ghostly", "http://localhost:9000");
    await expect(reach("http://localhost:9000/secret")).rejects.toThrow();
    await expect(reach("http://localhost:8080/")).rejects.toThrow();
    expect(fetched).toEqual([]);
  });

  it("is served once the person allows that address in this browser, and only that address", async () => {
    await shareIn("ghostly", "http://localhost:9000");
    await (await host()).requestLocalAccess("http://localhost/*", "http://localhost:9000");
    expect((await reach("http://localhost:9000/notes")).status).toBe(200);
    await expect(reach("http://localhost:9001/")).rejects.toThrow();
    expect(fetched).toEqual(["http://localhost:9000/notes"]);
  });

  it("is refused once Chrome's permission for the host is taken back", async () => {
    await (await host()).requestLocalAccess("http://localhost/*", "http://localhost:9000");
    world.hostAccess.delete("http://localhost/*");
    await expect(reach("http://localhost:9000/")).rejects.toThrow();
    expect(fetched).toEqual([]);
  });

  it("is refused in a profile other than the one that allowed it", async () => {
    useProfile(world, WORK, [WORK]);
    await (await host()).requestLocalAccess("http://localhost/*", "http://localhost:9000");
    useProfile(world, "", [WORK]);
    await expect(reach("http://localhost:9000/")).rejects.toThrow();
    expect(fetched).toEqual([]);
  });

  it("is refused after Clear all data, whatever comes back with a restore", async () => {
    await shareIn("ghostly", "http://localhost:9000");
    await (await host()).requestLocalAccess("http://localhost/*", "http://localhost:9000");
    await unshareIn("ghostly");
    await (await host()).releaseUnusedLocalAccess!();
    world.hostAccess.add("http://localhost/*");
    await shareIn("ghostly", "http://localhost:9000");
    await expect(reach("http://localhost:9000/")).rejects.toThrow();
  });
});

describe("a profile's apps all going at once", () => {
  /** The extension's host is the app's, and the peer clears its database as asked (`clearProfileData`). */
  async function page() {
    const extensionHost = await host();
    return world.load("page", async () => {
      const { setBrowserHost } = await import("@ghostly/browser/host");
      setBrowserHost(extensionHost);
      // The engine restart after a clear has nothing to do with the permissions.
      vi.spyOn(extensionHost, "restartEngine").mockResolvedValue();
      const { engine } = await import("@ghostly/browser/platform/engine");
      vi.spyOn(engine, "call").mockImplementation((async (method: string) => { if (method === "clearProfileData") await unshareIn("ghostly"); }) as never);
      vi.stubGlobal("window", { dispatchEvent: () => true });
      return { clearAllData: (await import("../../ui/src/lib/clearData")).clearAllData, deleteProfile: (await import("../../ui/src/lib/profileData")).deleteProfile };
    });
  }

  it("gives back on Clear all data every host only that profile shared an app at", async () => {
    await granted("http://127.0.0.1/*", "http://localhost/*");
    await shareIn("ghostly", "http://127.0.0.1:3400", "http://127.0.0.1:5000", "http://localhost:3400");
    await shareIn(`ghostly_${WORK}`, "http://localhost:8080");
    const { clearAllData } = await page();
    await clearAllData();
    expect(world.callsTo("permissions.remove")).toEqual([[{ origins: ["http://127.0.0.1/*"] }]]);
    expect([...world.hostAccess]).toEqual(["http://localhost/*"]);
  });

  it("gives back on Delete profile the hosts no profile left shares an app at", async () => {
    await granted("http://127.0.0.1/*", "http://localhost/*");
    await shareIn(`ghostly_${WORK}`, "http://127.0.0.1:3400", "http://localhost:3400");
    await shareIn("ghostly", "http://localhost:5000");
    const { deleteProfile } = await page();
    await deleteProfile(WORK);
    expect(world.callsTo("permissions.remove")).toEqual([[{ origins: ["http://127.0.0.1/*"] }]]);
    expect([...world.hostAccess]).toEqual(["http://localhost/*"]);
  });

  it("gives back nothing Chrome never granted, nor a permission that is not a local host's", async () => {
    world.hostAccess.add("https://example.com/*");
    await shareIn("ghostly");
    const { clearAllData } = await page();
    await clearAllData();
    expect(world.callsTo("permissions.remove")).toEqual([]);
    expect([...world.hostAccess]).toEqual(["https://example.com/*"]);
  });
});
