import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { SAVED_MESSAGES_KEY, readSavedMarks, type SavedMarks } from "@ghostly/browser/engine/saved";
import { STORES, setDatabaseName, store, wrap } from "@ghostly/browser/shared/idb";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: chat.saved, devices.handoff

/*
 * Saved marks on a person's own devices (WISP 06): one device of the set is active at a time, and the handoff moves
 * the whole profile to the one that takes the turn, the settings store with it. The marks are a row of that store, so
 * what was saved on the phone is saved on the laptop that takes the profile, and what was unsaved there is gone.
 */

const dropAll = async () => {
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};

const settingOf = (database: string, key: string) => new Promise<unknown>((resolve, reject) => {
  const r = indexedDB.open(database);
  r.onsuccess = () => { const got = r.result.transaction("settings", "readonly").objectStore("settings").get(key); got.onsuccess = () => { r.result.close(); resolve(got.result); }; };
  r.onerror = () => reject(r.error);
});

/** File storage as the origin-private file system keeps it; this profile has no files. */
const noFiles = (): FileBytes => ({ kind: "opfs", size: async () => null, remove: async () => {}, forSpace: () => noFiles() } as unknown as FileBytes);

beforeEach(async () => {
  await dropAll();
  setDatabaseName("ghostly");
  registerFileBytes("opfs", async () => noFiles());
  resetFileBytes(["opfs"]);
});
afterEach(async () => {
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  await dropAll();
});

describe("saved marks in a handoff", () => {
  it("the device that takes the profile has the giver's marks, as they are now", async () => {
    const marks: SavedMarks = { at: 3, items: [{ linkId: "chat1", id: "peer_a", savedAt: 1 }, { linkId: "group:g1", id: "m2", savedAt: 2 }] };
    await wrap((await store(STORES.settings, "readwrite")).put(marks, SAVED_MESSAGES_KEY));

    const host = handoffProfileHost("1.8.0", "web");
    const bundle = await host.source("ghostly").bundle();
    const staging = await host.staging.open();
    await staging.restore(bundle, []);

    expect(readSavedMarks(await settingOf(staging.database, SAVED_MESSAGES_KEY))).toEqual(marks.items);
  });
});
