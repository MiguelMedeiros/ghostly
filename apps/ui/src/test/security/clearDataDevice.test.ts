import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { createDeviceSigningKey, loadDeviceSigningKey } from "@ghostly/browser/devices/signingKey";
import { enrollDevice, readDeviceRecord, setDeviceMirror } from "@ghostly/browser/devices/store";
import { setHandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { databaseExists } from "@ghostly/browser/backup/database";
import { clearAllData } from "../../lib/clearData";
import { handoffProfileHost } from "../../lib/handoffProfile";
import { profileDatabase } from "../../lib/profileData";
import { activeProfileId } from "../../lib/profiles";
import { storeKey as peekKey } from "../../lib/profilePeek";

// covers: app.clear-data, devices.signing-key

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/** Desktop's fsynced copy of each record, in memory. */
const mirrored = new Map<string, string>();

beforeEach(() => {
  mirrored.clear();
  setDeviceMirror({
    read: async (profile) => mirrored.get(profile) ?? null,
    write: async (profile, record) => { if (record === null) mirrored.delete(profile); else mirrored.set(profile, record); },
  });
});
afterEach(() => { setDeviceMirror(null); setHandoffProfileHost(null); vi.restoreAllMocks(); });

const open = (name: string, upgrade?: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => upgrade?.(r.result);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
/** A peer database as a fork keeps it: a chat's message, a DID key and a nickname, and an unspent proof. */
async function peerCopy(name: string): Promise<void> {
  const db = await open(name, (d) => { for (const store of ["messages", "settings", "proofs"]) d.createObjectStore(store); });
  const tx = db.transaction(["messages", "settings", "proofs"], "readwrite");
  tx.objectStore("messages").put({ text: "only here" }, "m1");
  tx.objectStore("settings").put({ privateKey: "did-key" }, "profileDid");
  tx.objectStore("settings").put({ nickname: "old", mints: ["https://mint.example"] }, "settings");
  tx.objectStore("proofs").put({ amount: 21 }, "p1");
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  db.close();
}
async function read(name: string, store: string, key: string): Promise<unknown> {
  const db = await open(name);
  try {
    return await new Promise((resolve) => { const r = db.transaction(store, "readonly").objectStore(store).get(key); r.onsuccess = () => resolve(r.result); });
  } finally { db.close(); }
}

describe("Clear all data and the device set (WISP 04, WISP 06)", () => {
  it("takes this device out of the profile's device set: its record, Desktop's copy and its signing key go; another profile's stay", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    const own = profileDatabase(activeProfileId()), other = "ghostly_another";
    for (const profile of [own, other]) {
      await enrollDevice(profile, "active");
      await createDeviceSigningKey(profile, { forceSeed: true });
    }
    expect((await readDeviceRecord(own))?.state).toBe("active");
    expect(mirrored.has(own)).toBe(true);
    expect(await loadDeviceSigningKey(own)).not.toBeNull();

    await clearAllData();

    // The profile starts again as a device of no set (`single`), with no key the other devices know.
    expect(await readDeviceRecord(own)).toBeNull();
    expect(mirrored.has(own)).toBe(false);
    expect(await loadDeviceSigningKey(own)).toBeNull();
    expect((await readDeviceRecord(other))?.state).toBe("active");
    expect(mirrored.has(other)).toBe(true);
    expect(await loadDeviceSigningKey(other)).not.toBeNull();
  });

  it("clears the forks a handoff kept and drops a stopped pull's staged copy, which only the record named", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    setHandoffProfileHost(handoffProfileHost("1.1.7", "web"));
    const own = profileDatabase(activeProfileId()), fork = "ghostly_oldcopy1", staged = "ghostly_staged01";
    await peerCopy(fork);
    await peerCopy(staged);
    (await open(`${fork}-files`, (d) => d.createObjectStore("handles"))).close();
    localStorage.setItem("ghostly_oldcopy1_chat1", "a chat of the fork");
    localStorage.setItem("ghostly_staged01_chat1", "a staged chat");
    localStorage.setItem(peekKey(), JSON.stringify({ [activeProfileId()]: { at: 1, chats: { c1: { peer: "p", base: 0, texts: ["t1"], held: 0 } } } }));
    await enrollDevice(own, "standby", { forks: [fork], handoff: { role: "taking", step: "verified", staging: staged, old: own, at: 1 } });

    await clearAllData();

    expect(await readDeviceRecord(own)).toBeNull();
    // The fork goes as the profile does: its chats, keys, linked files and profile settings, never its wallets.
    expect(await read(fork, "messages", "m1")).toBeUndefined();
    expect(await read(fork, "settings", "profileDid")).toBeUndefined();
    expect(await read(fork, "settings", "settings")).toEqual({ mints: ["https://mint.example"] });
    expect(await read(fork, "proofs", "p1")).toEqual({ amount: 21 });
    expect(localStorage.getItem("ghostly_oldcopy1_chat1")).toBeNull();
    expect(await databaseExists(`${fork}-files`)).toBe(false);
    // The staged copy is the giver's, which still holds it: all of it goes.
    expect(await databaseExists(staged)).toBe(false);
    expect(localStorage.getItem("ghostly_staged01_chat1")).toBeNull();
    expect((JSON.parse(localStorage.getItem(peekKey()) ?? "{}") as Record<string, unknown>)[activeProfileId()]).toBeUndefined();
  });
});
