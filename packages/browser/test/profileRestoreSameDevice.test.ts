import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { createProfile, listProfiles, unregisterProfile } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, openProfileBackup, restoreOpenedBackup, sameIdentityProfiles } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.profile.same-device

/**
 * WISP 05 § Restoring on the same device: a bundle is a copy of a profile of this device when they share a chat key or
 * the DID key, since a copy restored beside it would answer its contacts as the same person.
 */

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
const PASS = "a long backup passphrase";
beforeEach(async () => {
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
  for (const db of await indexedDB.databases()) if (db.name) await wrap(indexedDB.deleteDatabase(db.name));
});

/** A profile's peer database with these chats (participation seeds) and this DID key. */
async function peerDatabase(name: string, chats: string[], didKey?: string) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const links = request.result.createObjectStore("links", { keyPath: "id" });
    chats.forEach((seed, i) => links.put({ id: `link-${i}`, participationSeed: seed, seedB64: "c2VlZA", peerPubKeyZ32: "peer" }));
    const settings = request.result.createObjectStore("settings");
    if (didKey) settings.put({ publicKey: didKey, listed: [] }, "profileDid");
  };
  (await wrap(request)).close();
}

it("warns about a backup made on this device, and not about one of a profile this device does not have", async () => {
  await peerDatabase("ghostly", [createIdentity().seedB64, createIdentity().seedB64], "did-key-personal");
  const work = createProfile("Work");
  await peerDatabase(`ghostly_${work.id}`, [createIdentity().seedB64], "did-key-work");

  const personal = await openProfileBackup(await createProfileBackup(PASS), PASS);
  expect((await sameIdentityProfiles(personal)).map((p) => p.name)).toEqual(["Personal"]);
  const ofWork = await openProfileBackup(await createProfileBackup(PASS, work.id), PASS);
  expect((await sameIdentityProfiles(ofWork)).map((p) => p.name)).toEqual(["Work"]);

  // Work leaves this device: its backup is now of no profile here.
  await wrap(indexedDB.deleteDatabase(`ghostly_${work.id}`));
  unregisterProfile(work.id);
  expect(await sameIdentityProfiles(ofWork)).toEqual([]);

  // Restored as a copy anyway, the copy is one more profile it is a copy of.
  const copy = await restoreOpenedBackup(personal);
  expect((await sameIdentityProfiles(personal)).map((p) => p.id)).toEqual(["", copy.id]);
  expect(listProfiles()).toHaveLength(2);
});

it("matches on one shared chat key, or on the DID key alone", async () => {
  const shared = createIdentity().seedB64;
  await peerDatabase("ghostly", [createIdentity().seedB64, shared]);
  const work = createProfile("Work");
  await peerDatabase(`ghostly_${work.id}`, [], "did-key-work");
  const other = createProfile("Other");
  await peerDatabase(`ghostly_${other.id}`, [shared]);

  const oneChat = await openProfileBackup(await createProfileBackup(PASS, other.id), PASS);
  expect((await sameIdentityProfiles(oneChat)).map((p) => p.name)).toEqual(["Personal", "Other"]);
  const didOnly = await openProfileBackup(await createProfileBackup(PASS, work.id), PASS);
  expect((await sameIdentityProfiles(didOnly)).map((p) => p.name)).toEqual(["Work"]);
});
