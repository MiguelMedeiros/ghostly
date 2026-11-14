import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { bootExtension, useProfile } from "./extension";

// covers: backup.profile.file, profiles.switch

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
vi.mock("@ghostly/browser/shared/idb", async (actual) => await actual());
vi.mock("../../ui/src/lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/**
 * A restore writes a whole profile, which takes a while for a large backup. A profile switch made meanwhile in another
 * tab started this page again at once: the restore was cut, its copy taken back at the next start, and nothing said.
 * The page now lets the restore end first; the copy it opens then is the profile every tab goes on with.
 */

const WORK = "work000000";
// Not a React hook: the fake world's profile in use.
const makeActive = useProfile;

let world: FakeWorld;

beforeEach(() => {
  resetEngine();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ["window", "location", "history", "sessionStorage"]) delete (globalThis as Record<string, unknown>)[key];
});

describe("a restore in this page while another tab switches", () => {
  async function page() {
    world = await bootExtension(undefined, (w) => makeActive(w, "", [WORK]));
    const order: string[] = [];
    const session = new Map<string, string>();
    const location = { hash: "#/profile", reload: () => order.push("reload") };
    const history = { replaceState: () => {} };
    Object.assign(globalThis, {
      window: Object.assign(new EventTarget(), { location, history }),
      sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => void session.set(key, value), removeItem: (key: string) => void session.delete(key) },
      location,
      history,
    });
    // The page as ui/main.tsx starts it, on the first profile.
    const loaded = await world.load("page", async () => {
      const profile = await import("../src/profile.ts");
      const { setStorageProfile } = await import("../../ui/src/lib/storage");
      const clear = await import("../../ui/src/lib/clearData");
      const backup = await import("../../ui/src/lib/profileBackup");
      const profiles = await import("../../ui/src/lib/profiles");
      setStorageProfile(profile.openPageProfile());
      profile.followProfileSwitch("", profile.startAsProfileInUse);
      profile.finishBeforeSwitching(() => clear.clearInProgress() ?? backup.restoreInProgress());
      return { backup, profiles };
    });
    const opened = await loaded.backup.openProfileBackup(await loaded.backup.createProfileBackup(null));
    // The restore's last step before its copy is listed waits for the test, as a large backup's writing would.
    let written!: () => void;
    const restoring = loaded.backup.restoreOpenedBackup(opened, {}, () => new Promise<void>((resolve) => (written = resolve)));
    await vi.waitFor(() => expect(written).toBeTypeOf("function"));
    // Another tab makes Work the profile in use.
    makeActive(world, WORK);
    world.page.dispatchEvent(Object.assign(new Event("storage"), { key: "ghostly_profiles" }));
    return { ...loaded, order, restoring, written: () => written() };
  }
  const registry = () => JSON.parse(world.storage.get("ghostly_profiles")!) as { active: string; profiles: { id: string; restored?: true }[] };

  it("lets the restore end, then starts again as the profile in use", async () => {
    const { order, restoring, written } = await page();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);

    written();
    const entry = await restoring;
    await vi.waitFor(() => expect(order).toEqual(["reload"]));
    // The copy is listed, and the switch made in the other tab stands.
    expect(registry().profiles.find((p) => p.id === entry.id)).toMatchObject({ restored: true });
    expect(registry().active).toBe(WORK);
  });

  it("opens the copy when the restore ends with that, and does not start again as the other tab's choice first", async () => {
    const { order, restoring, written, profiles } = await page();
    written();
    const entry = await restoring;
    // As ProfileBackups does once the restore is done.
    profiles.switchProfile(entry.id, { route: "/profile" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["reload"]);
    expect(registry().active).toBe(entry.id);
  });
});
