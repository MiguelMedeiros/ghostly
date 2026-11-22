import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { databaseExists } from "@ghostly/browser/backup/database";
import { amendDevice, closeDevicesDb, enrollDevice, readDeviceRecord } from "@ghostly/browser/devices/store";
import { setHandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import type { HandoffFile } from "@ghostly/browser/devices/handoff";
import { handoffProfileHost } from "../../lib/handoffProfile";
import { deleteProfile } from "../../lib/profileData";
import { listProfiles, namespaceOf, registerProfile, setRunningProfile } from "../../lib/profiles";
import { setStorageProfile } from "../../lib/storage";
// covers: profiles.delete, devices.handoff

/*
 * Deleting a profile for good takes what a move of it to this device staged and never installed (WISP 06 § The
 * handoff): a pull that stopped keeps its staged files and their notes for a later try, and one past pass 2 its staged
 * database (the whole profile, its keys included). Only the device record names that namespace, and deleting the
 * profile forgets the record: nothing named it afterwards, so the files, the notes and the database stayed.
 */

const OTHER = "abcdefghij";

/** File storage as the origin-private file system keeps it: one folder per profile space. */
const stored = new Map<string, Uint8Array>();
function folders(): FileBytes {
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    append: async (id: string, _offset: number, bytes: Uint8Array) => { stored.set(`${space}/${id}`, bytes); },
    flush: async () => {},
    close: async () => {},
    size: async (id: string) => stored.get(`${space}/${id}`)?.length ?? null,
    remove: async (id: string) => { stored.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    dropSpace: async (other: string) => { for (const key of [...stored.keys()]) if (key.startsWith(`${other}/`)) stored.delete(key); },
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return view("ghostly");
}

const fileOf = (n: number): HandoffFile => ({ id: `chat1-in-${n}-photo`, size: 3, sha256: String(n).padStart(43, "A") });
const BUNDLE: HandoffFile = { id: `app-${"b".repeat(43)}`, size: 3, sha256: "B".repeat(43) };
const space = (database: string) => database.replace(/^ghostly_/, "");
const notesOf = async (ns: string): Promise<number> => {
  if (!(await databaseExists("ghostly-staging"))) return 0;
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly-staging"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    return await new Promise<number>((resolve, reject) => {
      const r = db.transaction("files", "readonly").objectStore("files").count(IDBKeyRange.bound([ns], [ns, []]));
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
};
const legacyNotes = (ns: string) => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key) => !!key?.startsWith(`ghostly-staging:${ns}`));
const filesOf = (ns: string) => [...stored.keys()].filter((key) => key.startsWith(`ghostly_${ns}/`) || key.startsWith(`${ns}/`));

/** A standby of OTHER whose pull to this device stopped at `step`, with three files staged and, past pass 2, the staged database. */
async function stoppedPull(step: "stopped" | "verified") {
  const host = handoffProfileHost("1.1.7", "web");
  setHandoffProfileHost(host);
  const staging = await host.staging.open();
  for (let n = 0; n < 3; n++) { const file = fileOf(n); await staging.begin(file.id); await staging.append(file.id, 0, new Uint8Array(3)); await staging.finish(file); }
  // An installed app's bundle, which a move hands over beside the chat files.
  await staging.begin(BUNDLE.id); await staging.append(BUNDLE.id, 0, new Uint8Array(3)); await staging.finish(BUNDLE);
  const ns = space(staging.database);
  // A note an earlier build kept, one key per file (v1.10.1).
  localStorage.setItem(`ghostly-staging:${ns}:chat1-in-9-photo`, JSON.stringify({ size: 3, sha256: "9".padStart(43, "A") }));
  if (step === "verified") {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(staging.database, 1); r.onupgradeneeded = () => r.result.createObjectStore("identity"); r.onsuccess = () => resolve(r.result); });
    db.close();
  }
  const profile = `ghostly_${namespaceOf(OTHER)}`;
  await enrollDevice(profile, "standby", { handoff: { role: "taking", step, staging: staging.database, old: profile, at: 1 } });
  return { profile, staging: staging.database, ns };
}

beforeEach(async () => {
  localStorage.clear();
  stored.clear();
  await closeDevicesDb();
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly");
  setRunningProfile(undefined);
  setStorageProfile("");
  const store = folders();
  registerFileBytes("opfs", async () => store);
  resetFileBytes(["opfs"]);
  registerProfile(OTHER, "Other");
});
afterEach(async () => {
  setHandoffProfileHost(null);
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  await closeDevicesDb();
  localStorage.clear();
});

describe("deleting a profile whose move to this device stopped", () => {
  it.each(["stopped", "verified"] as const)("takes what the %s pull staged: its files, their notes and its database", async (step) => {
    const { profile, staging, ns } = await stoppedPull(step);
    expect((await readDeviceRecord(profile))?.handoff?.staging).toBe(staging);
    expect(await notesOf(ns)).toBe(4);
    expect(filesOf(ns).length).toBe(4);
    expect(await databaseExists(staging)).toBe(step === "verified");
    // The profile's own app bundle, in its own file storage.
    stored.set(`${profile}/${BUNDLE.id}`, new Uint8Array(3));

    await deleteProfile(OTHER);

    expect(stored.has(`${profile}/${BUNDLE.id}`)).toBe(false);

    expect(listProfiles().some((p) => p.id === OTHER)).toBe(false);
    expect(await readDeviceRecord(profile)).toBeNull();
    expect(await notesOf(ns)).toBe(0);
    expect(legacyNotes(ns)).toEqual([]);
    expect(filesOf(ns)).toEqual([]);
    expect(await databaseExists(staging)).toBe(false);
  });

  it("never takes a staging namespace a profile on the list runs on", async () => {
    const { staging } = await stoppedPull("verified");
    // A namespace a listed profile runs on is that profile's, whatever an old record says.
    const kept = "klmnopqrst";
    registerProfile(kept, "Kept");
    const profile = `ghostly_${namespaceOf(OTHER)}`;
    const own = `ghostly_${namespaceOf(kept)}`;
    await new Promise<void>((resolve) => { const r = indexedDB.open(own, 1); r.onupgradeneeded = () => r.result.createObjectStore("identity"); r.onsuccess = () => { r.result.close(); resolve(); }; });
    await enrollDevice(own, "active");
    await amendDevice(profile, { handoff: { role: "taking", step: "verified", staging: own, old: profile, at: 1 } });

    await deleteProfile(OTHER);

    expect(await databaseExists(own)).toBe(true);
    // The namespace the record no longer names stays as it was: this case is only about a listed profile's.
    expect(await databaseExists(staging)).toBe(true);
  });
});
