import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { digestText, registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { databaseOfSpace } from "../../lib/profiles";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * A move back to a device whose frozen copy holds the files (WISP 06 § Installing the staged state: "Files `B` already
 * held are linked into it, not copied"). Each file the frozen copy held was copied byte by byte into the staging's file
 * storage and hashed, then read back and written again as a Blob on its record: about twice the device's media history
 * written at every move back, though one text came since (bug hunt, 2026-11-04). A file kept as a Blob on its record
 * keeps that Blob: nothing of it goes through file storage.
 */

/** The rows the bundle restores into the staged database: the frozen copy's records, without their bytes. */
const restored = vi.hoisted(() => ({ rows: [] as object[] }));
vi.mock("../../lib/profileBackup", async (actual) => ({
  ...(await actual<typeof import("../../lib/profileBackup")>()),
  restoreHandoffBundle: async (_bundle: Uint8Array, ns: string) => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(databaseOfSpace(ns), 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("files", { keyPath: "id" }); };
      r.onsuccess = () => {
        const tx = r.result.transaction("files", "readwrite");
        for (const row of restored.rows) tx.objectStore("files").put(row);
        tx.oncomplete = () => { r.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
  },
}));

/** File storage as the origin-private file system keeps it, counting the bytes written and read. */
function folders() {
  const files = new Map<string, Uint8Array>();
  const calls = { written: 0, read: 0 };
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    append: async (id: string, offset: number, bytes: Uint8Array) => {
      const key = `${space}/${id}`, had = files.get(key) ?? new Uint8Array();
      if (had.length !== offset) throw new Error("File write out of order");
      const next = new Uint8Array(had.length + bytes.length);
      next.set(had); next.set(bytes, had.length);
      files.set(key, next);
      calls.written += bytes.length;
    },
    flush: async () => {},
    close: async () => {},
    size: async (id: string) => files.get(`${space}/${id}`)?.length ?? null,
    read: async (id: string, offset: number, length: number) => {
      const held = files.get(`${space}/${id}`);
      if (!held) throw new DOMException("No such file", "NotFoundError");
      const part = held.slice(offset, offset + length);
      calls.read += part.length;
      return part;
    },
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), files, calls };
}

const frozenCopy = (rows: object[]) => new Promise<void>((resolve, reject) => {
  const r = indexedDB.open("ghostly", 1);
  r.onupgradeneeded = () => { r.result.createObjectStore("files", { keyPath: "id" }); r.result.createObjectStore("fileState", { keyPath: "id" }); };
  r.onsuccess = () => {
    const tx = r.result.transaction("files", "readwrite");
    for (const row of rows) tx.objectStore("files").put(row);
    tx.oncomplete = () => { r.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  r.onerror = () => reject(r.error);
});

const rowsOf = (database: string) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
  const r = indexedDB.open(database);
  r.onsuccess = () => { const all = r.result.transaction("files", "readonly").objectStore("files").getAll(); all.onsuccess = () => { r.result.close(); resolve(all.result); }; };
  r.onerror = () => reject(r.error);
});

const dropAll = async () => {
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};

let storage: ReturnType<typeof folders>;
const blob = globalThis.Blob;
beforeEach(async () => {
  await dropAll();
  setDatabaseName("ghostly");
  storage = folders();
  registerFileBytes("opfs", async () => storage.store);
  resetFileBytes(["opfs"]);
  restored.rows = [];
  // Node's Blob: fake-indexeddb clones it whole, happy-dom's it does not.
  globalThis.Blob = NodeBlob as unknown as typeof Blob;
});
afterEach(async () => {
  globalThis.Blob = blob;
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  await dropAll();
});

describe("a move back keeps the files the frozen copy holds as Blobs where they are", () => {
  it.each([100, 400])("%i photos of 16 KiB: none written to file storage or read back, each record keeps its photo", async (count) => {
    const held = Array.from({ length: count }, (_, i) => {
      const bytes = Uint8Array.from({ length: 16 * 1024 }, (_, at) => (at * 7 + i) % 251);
      return { id: `chat1-in-${i}`, bytes, digest: digestText(sha256(bytes)) };
    });
    const record = (file: (typeof held)[number]) => ({ id: file.id, linkId: "chat1", direction: "in", digest: file.digest, createdAt: 1, metadata: { name: "photo.jpg", size: file.bytes.length, mime: "image/jpeg", timestamp: 1 } });
    await frozenCopy(held.map((file) => ({ ...record(file), blob: new NodeBlob([file.bytes], { type: "image/jpeg" }) })));
    restored.rows = held.map(record);
    const staging = await handoffProfileHost("1.9.0", "web").staging.open();
    const files = held.map((file) => ({ id: file.id, size: file.bytes.length, sha256: file.digest }));

    await staging.copyHeld(files.map((file) => ({ fromId: file.id, file })));
    expect(await staging.held()).toEqual(expect.arrayContaining(files));
    expect(await staging.held()).toHaveLength(files.length);
    await staging.restore(new Uint8Array(), files);

    expect(storage.calls).toEqual({ written: 0, read: 0 });
    const rows = new Map((await rowsOf(staging.database)).map((value) => [value.id as string, value]));
    const stored = held.map((file) => rows.get(file.id)!);
    expect(stored.map((row) => [row.digest, row.bytes, (row.blob as Blob).type])).toEqual(held.map((file) => [file.digest, undefined, "image/jpeg"]));
    const digests = await Promise.all(stored.map(async (row) => digestText(sha256(new Uint8Array(await (row.blob as Blob).arrayBuffer())))));
    expect(digests).toEqual(held.map((file) => file.digest));
  });

  it("a second record of a held photo (the same file in another chat) gets the same Blob", async () => {
    const bytes = Uint8Array.from({ length: 2_000 }, (_, at) => (at * 5) % 249), digest = digestText(sha256(bytes));
    const record = (id: string) => ({ id, linkId: "chat1", direction: "in", digest, createdAt: 1, metadata: { name: "photo.jpg", size: bytes.length, mime: "image/jpeg", timestamp: 1 } });
    await frozenCopy([{ ...record("chat1-in-a"), blob: new NodeBlob([bytes]) }]);
    restored.rows = [record("chat1-in-a"), record("chat2-in-b")];
    const staging = await handoffProfileHost("1.9.0", "web").staging.open();
    const first = { id: "chat1-in-a", size: bytes.length, sha256: digest }, second = { ...first, id: "chat2-in-b" };

    await staging.copyHeld([{ fromId: "chat1-in-a", file: first }]);
    await staging.copyStaged("chat1-in-a", second);
    await staging.restore(new Uint8Array(), [first, second]);

    expect(storage.calls).toEqual({ written: 0, read: 0 });
    for (const stored of await rowsOf(staging.database)) expect(new Uint8Array(await (stored.blob as Blob).arrayBuffer())).toEqual(bytes);
  });

  it("a held Blob whose record names other bytes is copied and checked as before, and left out when it is not the file", async () => {
    const bytes = Uint8Array.from({ length: 900 }, (_, at) => (at * 3) % 241);
    await frozenCopy([{ id: "chat1-in-x", linkId: "chat1", direction: "in", digest: "A".repeat(43), blob: new NodeBlob([bytes]), createdAt: 1, metadata: { name: "x.jpg", size: bytes.length, mime: "image/jpeg", timestamp: 1 } }]);
    const staging = await handoffProfileHost("1.9.0", "web").staging.open();

    await staging.copyHeld([{ fromId: "chat1-in-x", file: { id: "chat1-in-x", size: bytes.length, sha256: digestText(sha256(new Uint8Array(900))) } }]);

    expect(await staging.held()).toEqual([]);
  });
});
