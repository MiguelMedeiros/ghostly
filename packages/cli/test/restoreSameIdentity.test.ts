import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import { identityKeys, refuseSameProfile } from "../src/backup";
import { CliError } from "../src/errors";
import { profilePaths } from "../src/profiles";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.backup

const opened: PersistentIndexedDb[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((store) => store.close())); });

/** A profile's store in `dir` with these chats (`links` rows) and, when given, this DID key, as the engine keeps them. */
async function storeWith(dir: string, links: Record<string, unknown>[], did?: string): Promise<void> {
  const store = await openPersistentIndexedDb(dir);
  opened.push(store);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = store.factory.open("ghostly", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("links", { keyPath: "id" }); request.result.createObjectStore("settings"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(["links", "settings"], "readwrite");
  for (const link of links) tx.objectStore("links").put(link);
  if (did) tx.objectStore("settings").put({ publicKey: did }, "profileDid");
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
  db.close();
  // Closed at once: a store left open journals every later store's writes too (the classes it hooks are shared).
  await store.close();
  opened.splice(opened.indexOf(store), 1);
}

const refusal = (home: string, db: string): unknown => {
  try { refuseSameProfile(home, db, false); return null; } catch (error) { return error instanceof CliError ? { code: error.code, details: error.details } : error; }
};

it("a backup that shares only a chat's key with a profile here is the same person; another key is not", async () => {
  const home = mkdtempSync(join(tmpdir(), "ghostly-same-chat-"));
  const participation = createIdentity().seedB64, older = createIdentity().seedB64;
  // Here: a chat with a participation key, an older chat with its chat key only, a row whose key is no seed, and a DID.
  await storeWith(profilePaths(home, "alice").db, [
    { id: "chat-1", seedB64: createIdentity().seedB64, participationSeed: participation },
    { id: "chat-2", seedB64: older },
    { id: "chat-3", seedB64: "not a seed" },
  ], "alice-did");
  expect([...identityKeys(profilePaths(home, "alice").db)]).toHaveLength(3);

  // Backups without the DID: only the chat keys can match.
  const shares = async (links: Record<string, unknown>[]) => {
    const db = mkdtempSync(join(tmpdir(), "ghostly-bundle-"));
    await storeWith(db, links);
    return refusal(home, db);
  };
  const same = { code: "refused", details: { reason: "same-profile", profiles: ["alice"] } };
  expect(await shares([{ id: "chat-1", seedB64: createIdentity().seedB64, participationSeed: participation }]), "the participation key").toEqual(same);
  expect(await shares([{ id: "chat-2", seedB64: older }]), "an older chat's own key").toEqual(same);
  expect(await shares([{ id: "chat-1", seedB64: participation }]), "the same key as an older chat's").toEqual(same);
  expect(await shares([{ id: "chat-1", seedB64: createIdentity().seedB64, participationSeed: createIdentity().seedB64 }]), "another participation key").toBeNull();
  expect(await shares([{ id: "chat-3", seedB64: "not a seed" }]), "a key that is no seed matches nothing").toBeNull();
  expect(await shares([]), "nothing to compare").toBeNull();
  const unread = mkdtempSync(join(tmpdir(), "ghostly-bundle-"));
  writeFileSync(join(unread, "snapshot.bin"), "not a snapshot");
  expect(refusal(home, unread), "a backup's store this cannot read has nothing to compare").toBeNull();
});
