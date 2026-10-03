import { expect, it } from "vitest";
import { DB_VERSION } from "@ghostly/browser/shared/idb";
import { profilePaths } from "../src/profiles";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { error, ghostly, home, ok } from "./support/cli";
// covers: app.profile-unavailable, headless.storage

/**
 * A profile last used by a newer ghostly: its store's database is at a schema version above this build's. IndexedDB
 * (fake-indexeddb here, as in a browser) refuses to open it. The command says so with the versions, exits as the
 * engine's failures do, and the store is left exactly as the newer build wrote it.
 */

const open = (name: string, version?: number, upgrade?: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => upgrade?.(request.result);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const settingsOf = (db: IDBDatabase) => new Promise<{ nick?: string }>((resolve, reject) => {
  const request = db.transaction("settings").objectStore("settings").get("settings");
  request.onsuccess = () => resolve(request.result as { nick?: string });
  request.onerror = () => reject(request.error);
});

it("an older ghostly on a newer profile: `engine` with both versions, from status and from a send, and the store untouched", async () => {
  const dir = home("newer-profile");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Newer bot"]));
  const paths = profilePaths(dir, "default");

  // A newer build opens the profile: its database moves to the next version, with a store this build knows nothing of.
  const newer = await openPersistentIndexedDb(paths.db);
  (await open("ghostly", DB_VERSION + 1, (db) => { db.createObjectStore("fromTheFuture"); })).close();
  await newer.close();

  const message = `This profile was last used by a newer version of Ghostly (its data is version ${DB_VERSION + 1}, this version reads up to ${DB_VERSION}). Update Ghostly to open it.`;
  const details = { reason: "newer_profile", storedVersion: DB_VERSION + 1, supportedVersion: DB_VERSION };
  const status = await ghostly(["--home", dir, "status"]);
  expect(error(status, "engine", 1)).toEqual({ code: "engine", message, details });
  // Not the browser's raw words, and no stack on stderr.
  expect(status.stdout + status.stderr).not.toMatch(/VersionError|\n\s+at /);
  expect(error(await ghostly(["--home", dir, "chat", "list"]), "engine", 1).message).toBe(message);
  expect(error(await ghostly(["--home", dir, "profile", "set", "--name", "Renamed"]), "engine", 1).message).toBe(message);

  // The three commands each loaded the store and folded it again: still the newer version, the new store and the name.
  const after = await openPersistentIndexedDb(paths.db);
  const db = await open("ghostly");
  expect(db.version).toBe(DB_VERSION + 1);
  expect([...db.objectStoreNames]).toContain("fromTheFuture");
  expect((await settingsOf(db)).nick).toBe("Newer bot");
  db.close();
  await after.close();
}, 120_000);
