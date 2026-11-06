import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { bootExtension, useProfile } from "./extension";

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

/** The apps a profile's database lists now. */
async function targetsIn(dbName: string): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains("services")) return [];
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction("services", "readonly").objectStore("services").getAll();
      request.onsuccess = () => resolve((request.result as { target: string }[]).map((row) => row.target).sort());
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

describe("a share in another tab while the last app at its host goes", () => {
  /** A Services page of the other profile on the extension's host; the peer adds the app's row as `addService` does. */
  async function servicesPage() {
    const extensionHost = await host();
    return world.load("page", async () => {
      const { setBrowserHost } = await import("@ghostly/browser/host");
      setBrowserHost(extensionHost);
      const { engine } = await import("@ghostly/browser/platform/engine");
      const call = vi.spyOn(engine, "call").mockImplementation((async (method: string, params: { target: string }) => {
        if (method === "addService") await shareIn(`ghostly_${WORK}`, params.target);
      }) as never);
      const { servicesPlatform } = await import("@ghostly/browser/platform/services");
      return { services: servicesPlatform!, adds: () => call.mock.calls.filter(([method]) => method === "addService").length };
    });
  }

  /** Holds Chrome's next `permissions.remove` until `open()`; `reached` resolves once it is called. */
  function holdRemove(): { reached: Promise<void>; open: () => void } {
    const remove = world.chrome.permissions.remove.bind(world.chrome.permissions) as (request: chrome.permissions.Permissions) => Promise<boolean>;
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const at = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(world.chrome.permissions, "remove").mockImplementationOnce((async (request: chrome.permissions.Permissions) => {
      reached();
      await gate;
      return remove(request);
    }) as never);
    return { reached: at, open };
  }

  it("keeps Chrome's access for the app shared between the other tab's read and its remove", async () => {
    await granted("http://127.0.0.1/*");
    await shareIn("ghostly", "http://127.0.0.1:3400");
    const { services, adds } = await servicesPage();
    // Tab A: its only app at 127.0.0.1 went, it read every profile's apps and is about to give the pattern back.
    await unshareIn("ghostly", "http://127.0.0.1:3400");
    const held = holdRemove();
    const forgetting = (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    await held.reached;
    // Tab B shares an app at the same host: Chrome says yes at once, the pattern being still granted.
    const sharing = services.shareService("notes", "http://127.0.0.1:5000");
    await settle();
    held.open();
    await Promise.all([forgetting, sharing]);
    expect(await targetsIn(`ghostly_${WORK}`)).toEqual(["http://127.0.0.1:5000"]);
    expect([...world.hostAccess]).toEqual(["http://127.0.0.1/*"]);
    // B's app was added once, after the give-back, with Chrome asked again for what A gave back.
    expect(adds()).toBe(1);
    expect(world.callsTo("permissions.request").slice(1)).toEqual([[{ origins: ["http://127.0.0.1/*"] }], [{ origins: ["http://127.0.0.1/*"] }]]);
  });

  it("still gives the pattern back when two tabs remove the last two apps at one host", async () => {
    await granted("http://127.0.0.1/*");
    await shareIn("ghostly", "http://127.0.0.1:3400");
    await shareIn(`ghostly_${WORK}`, "http://127.0.0.1:8080");
    await unshareIn("ghostly", "http://127.0.0.1:3400");
    const held = holdRemove();
    const extensionHost = await host();
    const first = extensionHost.forgetLocalAccess!("http://127.0.0.1:3400").catch(() => {});
    // A's read saw the other app gone already (no remove) or held its remove: either way B's ends with nothing left.
    await Promise.race([held.reached, first]);
    await unshareIn(`ghostly_${WORK}`);
    const second = extensionHost.forgetLocalAccess!("http://127.0.0.1:8080");
    await settle();
    held.open();
    await Promise.all([first, second]);
    expect([...world.hostAccess]).toEqual([]);
  });

  it("shares and gives back as before when nothing runs alongside", async () => {
    const { services, adds } = await servicesPage();
    await services.shareService("notes", "http://127.0.0.1:5000");
    expect(world.callsTo("permissions.request")).toEqual([[{ origins: ["http://127.0.0.1/*"] }]]);
    expect(adds()).toBe(1);
    expect([...world.hostAccess]).toEqual(["http://127.0.0.1/*"]);
    await unshareIn(`ghostly_${WORK}`);
    await (await host()).forgetLocalAccess!("http://127.0.0.1:5000");
    expect([...world.hostAccess]).toEqual([]);
    // Chrome says no: nothing is added.
    world.permissionsGranted = false;
    await expect(services.shareService("notes", "http://127.0.0.1:5000")).rejects.toThrow("Ghostly needs your permission");
    expect(adds()).toBe(1);
    expect(await targetsIn(`ghostly_${WORK}`)).toEqual([]);
  });

  it("gives a pattern back while another tab's prompt for a new host is still open", async () => {
    await granted("http://127.0.0.1/*");
    const { services, adds } = await servicesPage();
    let answer!: (yes: boolean) => void;
    const request = world.chrome.permissions.request.bind(world.chrome.permissions) as (request: chrome.permissions.Permissions) => Promise<boolean>;
    vi.spyOn(world.chrome.permissions, "request").mockImplementationOnce((async (asked: chrome.permissions.Permissions) => {
      await new Promise<boolean>((resolve) => { answer = resolve; });
      return request(asked);
    }) as never);
    const sharing = services.shareService("notes", "http://localhost:3400");
    await settle();
    // The prompt holds no lock: the other tab's give-back is not kept waiting behind the person's answer.
    await (await host()).forgetLocalAccess!("http://127.0.0.1:3400");
    expect([...world.hostAccess]).toEqual([]);
    answer(true);
    await sharing;
    expect(adds()).toBe(1);
    expect([...world.hostAccess]).toEqual(["http://localhost/*"]);
  });
});
