import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { digestText, registerFileBytes, resetFileBytes, type FileBytes, type FileBytesKind } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { databaseOfSpace } from "../../lib/profiles";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * An installed app's bundle is kept whole in file storage as `app-<digest>`, with no `files` row. A move listed only the
 * `files` rows, so it handed over none: on the new device every app showed "Needs its files" and fetched its bundle
 * again, and one whose source no longer served that version did not open there at all, though WISP 1200 § Where
 * installed apps live says a handoff moves the bundles by digest (bug hunt, 2026-11-06).
 */

/** The rows the bundle restores into the staged database, in place of the bundle itself. */
const restored = vi.hoisted(() => ({ files: [] as object[], apps: [] as object[] }));
vi.mock("../../lib/profileBackup", async (actual) => ({
  ...(await actual<typeof import("../../lib/profileBackup")>()),
  restoreHandoffBundle: (_bundle: Uint8Array, ns: string) => profileDatabase(databaseOfSpace(ns), restored.files, restored.apps),
}));

/** File storage of one kind: one folder per profile space. */
function folders(kind: FileBytesKind) {
  const files = new Map<string, Uint8Array>();
  const view = (space: string): FileBytes => ({
    kind,
    append: async (id: string, offset: number, bytes: Uint8Array) => {
      const key = `${space}/${id}`, had = files.get(key) ?? new Uint8Array();
      if (had.length !== offset) throw new Error("File write out of order");
      const next = new Uint8Array(had.length + bytes.length);
      next.set(had); next.set(bytes, had.length);
      files.set(key, next);
    },
    flush: async () => {},
    close: async () => {},
    size: async (id: string) => files.get(`${space}/${id}`)?.length ?? null,
    read: async (id: string, offset: number, length: number) => {
      const held = files.get(`${space}/${id}`);
      if (!held) throw new DOMException("No such file", "NotFoundError");
      return held.slice(offset, offset + length);
    },
    digest: async (id: string) => digestText(sha256(files.get(`${space}/${id}`) ?? new Uint8Array())),
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    dropSpace: async (other: string) => { for (const key of [...files.keys()]) if (key.startsWith(`${other}/`)) files.delete(key); },
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), files };
}

/** A profile's peer database: its file records and its installed apps, as the app stores them. */
function profileDatabase(name: string, files: object[], apps: object[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("files", { keyPath: "id" });
      r.result.createObjectStore("fileState", { keyPath: "id" });
      r.result.createObjectStore("apps", { keyPath: "ref" });
    };
    r.onsuccess = () => {
      const tx = r.result.transaction(["files", "apps"], "readwrite");
      for (const row of files) tx.objectStore("files").put(row);
      for (const app of apps) tx.objectStore("apps").put(app);
      tx.oncomplete = () => { r.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
}

const allOf = (database: string, store: string) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
  const r = indexedDB.open(database);
  r.onsuccess = () => { const all = r.result.transaction(store, "readonly").objectStore(store).getAll(); all.onsuccess = () => { r.result.close(); resolve(all.result); }; };
  r.onerror = () => reject(r.error);
});

/**
 * The giver's database: never deleted, as the source keeps its connection to it open (a move does). A delete waits on
 * it, and every later one of it queues behind that.
 */
const GIVER = "ghostly_giver";
const dropAll = async () => {
  for (const { name } of await indexedDB.databases()) if (name && name !== GIVER) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};

/** A bundle's bytes and its app digest (of its manifest, not of these bytes). */
const bundle = (n: number) => {
  const bytes = Uint8Array.from({ length: 2_000 + n }, (_, i) => (i * 7 + n) % 251);
  return { bytes, digest: digestText(sha256(Uint8Array.of(n))), sha256: digestText(sha256(bytes)) };
};
const app = (ref: string, digest: string, bytes: FileBytesKind, pending?: { digest: string; bytes: FileBytesKind }) =>
  ({ ref, publisher: "p", name: ref, sequence: 1, digest, permissions: [], manifest: {}, bytes, from: "https://example.test/app.ghostly", installedAt: 1, updatedAt: 1, ...(pending && { pending: { ...pending, sequence: 2, manifest: {}, added: [], from: "https://example.test/app2.ghostly", at: 1 } }) });

let opfs: ReturnType<typeof folders>, native: ReturnType<typeof folders>;
const blob = globalThis.Blob;
beforeEach(async () => {
  await dropAll();
  setDatabaseName("ghostly");
  opfs = folders("opfs");
  native = folders("native");
  registerFileBytes("opfs", async () => opfs.store);
  registerFileBytes("native", async () => native.store);
  resetFileBytes(["opfs"]);
  restored.files = []; restored.apps = [];
  // Node's Blob: fake-indexeddb clones it whole, happy-dom's it does not.
  globalThis.Blob = NodeBlob as unknown as typeof Blob;
});
afterEach(async () => {
  globalThis.Blob = blob;
  registerFileBytes("opfs", async () => null);
  registerFileBytes("native", async () => null);
  resetFileBytes();
  await dropAll();
});

describe("a move hands over the installed apps' bundles", () => {
  it("the giver lists each bundle its apps' records name, the version installed and the one waiting, beside the chat files", async () => {
    const [installed, waiting, missing] = [bundle(1), bundle(2), bundle(3)];
    const photo = Uint8Array.from({ length: 900 }, (_, i) => (i * 5) % 239);
    const giver = GIVER, space = opfs.store.forSpace!(giver);
    await space.append(`app-${installed.digest}`, 0, installed.bytes);
    await space.append(`app-${waiting.digest}`, 0, waiting.bytes);
    await space.append("link1-in-f1", 0, photo);
    await profileDatabase(giver,
      [{ id: "link1-in-f1", linkId: "link1", direction: "in", bytes: "opfs", digest: digestText(sha256(photo)), createdAt: 1, metadata: { name: "a.jpg", size: photo.length, mime: "image/jpeg", timestamp: 1 } }],
      [app("chess", installed.digest, "opfs", { digest: waiting.digest, bytes: "opfs" }), app("notes", missing.digest, "opfs")]);
    const source = handoffProfileHost("1.10.2", "web").source(giver);

    const files = await source.files();

    expect(files).toEqual(expect.arrayContaining([
      { id: "link1-in-f1", size: photo.length, sha256: digestText(sha256(photo)) },
      { id: `app-${installed.digest}`, size: installed.bytes.length, sha256: installed.sha256 },
      { id: `app-${waiting.digest}`, size: waiting.bytes.length, sha256: waiting.sha256 },
    ]));
    // One not on this device needs its files on the new one as on this one.
    expect(files).toHaveLength(3);
    expect(await source.read(`app-${installed.digest}`, 10, 5)).toEqual(installed.bytes.slice(10, 15));
  });

  it("a taker whose frozen copy holds a bundle copies it from its file storage", async () => {
    const held = bundle(4);
    await opfs.store.append(`app-${held.digest}`, 0, held.bytes);
    await profileDatabase("ghostly", [], [app("chess", held.digest, "opfs")]);
    const staging = await handoffProfileHost("1.10.2", "web").staging.open();
    const file = { id: `app-${held.digest}`, size: held.bytes.length, sha256: held.sha256 };

    await staging.copyHeld([{ fromId: file.id, file }]);

    expect(await staging.held()).toEqual([file]);
    expect(opfs.files.get(`${staging.database}/${file.id}`)).toEqual(held.bytes);
  });

  it("the taker keeps the staged bundles in file storage and points the apps' records at where it keeps them", async () => {
    // The taker keeps files natively (Desktop); the giver's records say its origin-private file system.
    resetFileBytes(["native"]);
    const [installed, waiting, missing] = [bundle(5), bundle(6), bundle(7)];
    const photo = Uint8Array.from({ length: 300 }, (_, i) => (i * 3) % 241);
    const staging = await handoffProfileHost("1.10.2", "web").staging.open();
    const files = [
      { id: `app-${installed.digest}`, size: installed.bytes.length, sha256: installed.sha256, bytes: installed.bytes },
      { id: `app-${waiting.digest}`, size: waiting.bytes.length, sha256: waiting.sha256, bytes: waiting.bytes },
      { id: "link1-in-f1", size: photo.length, sha256: digestText(sha256(photo)), bytes: photo },
    ];
    for (const file of files) await native.store.forSpace!(staging.database).append(file.id, 0, file.bytes);
    restored.files = [{ id: "link1-in-f1", linkId: "link1", direction: "in", createdAt: 1, metadata: { name: "a.jpg", size: photo.length, mime: "image/jpeg", timestamp: 1 } }];
    restored.apps = [app("chess", installed.digest, "opfs", { digest: waiting.digest, bytes: "opfs" }), app("notes", missing.digest, "opfs")];

    await staging.restore(new Uint8Array(), files.map(({ id, size, sha256: digest }) => ({ id, size, sha256: digest })));

    // Small as they are, the bundles stay where the engine reads them; the photo moved onto its record.
    expect(native.files.get(`${staging.database}/app-${installed.digest}`)).toEqual(installed.bytes);
    expect(native.files.get(`${staging.database}/app-${waiting.digest}`)).toEqual(waiting.bytes);
    expect(native.files.has(`${staging.database}/link1-in-f1`)).toBe(false);
    const apps = new Map((await allOf(staging.database, "apps")).map((value) => [value.ref, value]));
    expect(apps.get("chess")).toMatchObject({ bytes: "native", pending: { digest: waiting.digest, bytes: "native" } });
    // Its bundle was not handed over: still needs its files, as it did on the giver.
    expect(apps.get("notes")).toMatchObject({ bytes: "opfs" });
    const [row] = await allOf(staging.database, "files");
    expect(new Uint8Array(await (row.blob as Blob).arrayBuffer())).toEqual(photo);
  });

  it("a staging dropped (a move stopped, or the frozen copy once the move is installed) takes its bundles with it", async () => {
    const staged = bundle(8);
    const host = handoffProfileHost("1.10.2", "web");
    const staging = await host.staging.open();
    const file = { id: `app-${staged.digest}`, size: staged.bytes.length, sha256: staged.sha256 };
    await staging.begin([file.id]);
    await staging.append(file.id, 0, staged.bytes);
    await staging.finish(file);
    expect(opfs.files.has(`${staging.database}/${file.id}`)).toBe(true);

    await host.staging.drop(staging.database);

    expect([...opfs.files.keys()].filter((key) => key.startsWith(`${staging.database}/`))).toEqual([]);
  });
});
