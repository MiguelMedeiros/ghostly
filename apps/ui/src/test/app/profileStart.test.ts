import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseName, setDatabaseName } from "@ghostly/browser/shared/idb";
import { openProfile } from "../../lib/profileStart";
import { activeProfileId, pointProfile, registryKey, setProfileBase, setRunningProfile } from "../../lib/profiles";
import { setStorageProfile } from "../../lib/storage";
// covers: app.i18n

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
