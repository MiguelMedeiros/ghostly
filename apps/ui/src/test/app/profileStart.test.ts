import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseName, setDatabaseName } from "@ghostly/browser/shared/idb";
import { openProfile } from "../../lib/profileStart";
import { activeProfileId, pointProfile, registryKey, setProfileBase, setRunningProfile, switchProfile } from "../../lib/profiles";
import { setStorageProfile } from "../../lib/storage";
// covers: app.i18n, profiles.switch

/*
 * The entry points open the chosen profile before anything renders (apps/web and apps/ui main.tsx). The web entry is a
 * module that awaits the handoff pointer recovery (IndexedDB), and a module that awaits lets the browser paint: the
 * full E2E of 2026-10-04 saw a reload in Arabic paint in English, left to right, once that wait came before the language.
 */

const STAGED = "stageaaaaa";
const html = document.documentElement;
const writeRegistry = (profiles: object[]) => localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: "", profiles }));

beforeEach(() => {
  localStorage.clear();
  setProfileBase("");
  setRunningProfile(undefined);
  setStorageProfile("");
  html.lang = "";
  html.dir = "";
});
afterEach(() => {
  localStorage.clear();
  setRunningProfile(undefined);
  setStorageProfile("");
  setDatabaseName("ghostly");
  html.lang = "";
  html.dir = "";
});

describe("opening the chosen profile", () => {
  it("puts its language on <html> before it waits on the pointer recovery", () => {
    writeRegistry([{ id: "", name: "Personal", createdAt: 0 }]);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "ar" }));
    void openProfile(() => new Promise(() => {}));
    expect([html.lang, html.dir]).toEqual(["ar", "rtl"]);
  });

  it("reads the language again from the state a recovered pointer names, and opens that state", async () => {
    writeRegistry([{ id: "", name: "Personal", createdAt: 0 }]);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "ar" }));
    localStorage.setItem(`ghostly_${STAGED}_app_settings`, JSON.stringify({ language: "pt" }));
    const namespace = await openProfile(async () => { pointProfile("ghostly", `ghostly_${STAGED}`); });
    expect(namespace).toBe(STAGED);
    expect(activeProfileId()).toBe("");
    expect(databaseName()).toBe(`ghostly_${STAGED}`);
    expect([html.lang, html.dir]).toEqual(["pt-BR", "ltr"]);
  });
});

/*
 * A reload starts the page anew: modules evaluated again, nothing in memory. Accepting a new version in one tab reloads
 * every tab of the app (followNewVersion); the back/forward cache restart and a reload by the person do the same.
 */
async function reloadedPage() {
  vi.resetModules();
  const start = await import("../../lib/profileStart");
  const profiles = await import("../../lib/profiles");
  return { openProfile: start.openProfile, profiles };
}
const WORK = "workaaaaaa";
const twoProfiles = (active: string) => localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active, profiles: [{ id: "", name: "Personal", createdAt: 0 }, { id: WORK, name: "Work", createdAt: 1 }] }));

describe("a tab across its own reloads", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it("starts again as the profile it ran, though another tab chose another one meanwhile", async () => {
    twoProfiles("");
    expect(await openProfile(async () => {})).toBe("");
    // The other tab switches to Work, then accepts a new version: this tab reloads with it.
    twoProfiles(WORK);
    const page = await reloadedPage();
    expect(await page.openProfile(async () => {}), "Personal's storage, not Work's").toBe("");
    expect(page.profiles.activeProfileId()).toBe("");
    // A tab opened afresh starts as the profile last chosen.
    sessionStorage.clear();
    const fresh = await reloadedPage();
    expect(await fresh.openProfile(async () => {})).toBe(WORK);
  });

  it("starts as the profile it switched to, though another tab chose another one before it reloaded", async () => {
    twoProfiles("");
    await openProfile(async () => {});
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hash: "#/", reload } as Location);
    vi.useFakeTimers();
    try {
      switchProfile(WORK);
      vi.advanceTimersByTime(100);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    expect(reload).toHaveBeenCalledOnce();
    twoProfiles("");
    const page = await reloadedPage();
    expect(await page.openProfile(async () => {})).toBe(WORK);
  });

  it("starts as the profile last chosen when the one it ran is gone", async () => {
    twoProfiles(WORK);
    setRunningProfile(WORK);
    localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: "", profiles: [{ id: "", name: "Personal", createdAt: 0 }] }));
    const page = await reloadedPage();
    expect(await page.openProfile(async () => {})).toBe("");
  });
});
