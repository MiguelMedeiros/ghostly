import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { SMALL_FILE_BYTES, digestText, registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { databaseOfSpace } from "../../lib/profiles";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * The last step of pass 2 on the device that takes a profile (WISP 06 § The handoff): once the rest of the profile is
 * in the staged database, each file's record is pointed at the bytes staged for it. Both devices wait for it (the
 * giver is frozen until `handoff-verified`). It took two transactions per file, one after the other: 2,000 files with
 * a 50 kB photo each took 6.3 s in Chrome against 0.5 s written 200 to a transaction (bug hunt, 2026-10-09).
 */

/** The rows the bundle restores into the staged database, in place of the bundle itself. */
const restored = vi.hoisted(() => ({ rows: [] as object[], transactions: [] as string[] }));
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
    restored.transactions.length = 0;
  },
}));

/** File storage as the origin-private file system keeps it: one folder per profile space. */
function folders() {
  const files = new Map<string, Uint8Array>();
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    size: async (id: string) => files.get(`${space}/${id}`)?.length ?? null,
    read: async (id: string, offset: number, length: number) => {
      const held = files.get(`${space}/${id}`);
      if (!held) throw new DOMException("No such file", "NotFoundError");
      return held.slice(offset, offset + length);
    },
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), files };
}

const dropAll = async () => {
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};

const rowsOf = (database: string) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
  const r = indexedDB.open(database);
  r.onsuccess = () => { const all = r.result.transaction("files", "readonly").objectStore("files").getAll(); all.onsuccess = () => { r.result.close(); resolve(all.result); }; };
  r.onerror = () => reject(r.error);
});

const row = (id: string, more: object = {}) => ({ id, linkId: "chat1", direction: "in", createdAt: 1, metadata: { name: `${id}.jpg`, size: 3, mime: "image/jpeg", timestamp: 1 }, ...more });

let storage: ReturnType<typeof folders>;
const open = IDBDatabase.prototype.transaction;
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
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    restored.transactions.push(`${this.name} ${args[1] ?? "readonly"}`);
    return open.apply(this, args);
  };
});
afterEach(async () => {
  IDBDatabase.prototype.transaction = open;
  globalThis.Blob = blob;
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  await dropAll();
});

describe("a taker points each restored file record at its staged bytes", () => {
  it("450 files' records are written in three transactions, not two for each file", async () => {
    const staging = await handoffProfileHost("1.1.8", "web").staging.open();
    const files = Array.from({ length: 450 }, (_, i) => {
      const id = `chat1-in-${i}`, large = i % 3 === 0, bytes = Uint8Array.from({ length: 40 + i }, (_, at) => (at * 7 + i) % 251);
      if (!large) storage.files.set(`${staging.database}/${id}`, bytes);
      return { id, size: large ? SMALL_FILE_BYTES + 1 + i : bytes.length, sha256: digestText(sha256(bytes)), bytes, large };
    });
    restored.rows = files.map((file) => row(file.id));

    await staging.restore(new Uint8Array(), files.map(({ id, size, sha256 }) => ({ id, size, sha256 })));

    expect(restored.transactions).toEqual(Array.from({ length: 3 }, () => `${staging.database} readwrite`));
    const rows = new Map((await rowsOf(staging.database)).map((value) => [value.id as string, value]));
    for (const file of files) {
      const stored = rows.get(file.id)!;
      expect(stored.digest).toBe(file.sha256);
      expect(stored.linkId).toBe("chat1");
      if (file.large) { expect(stored.bytes).toBe("opfs"); expect(stored.blob).toBeUndefined(); continue; }
      expect(stored.bytes).toBeUndefined();
      expect(new Uint8Array(await (stored.blob as Blob).arrayBuffer())).toEqual(file.bytes);
      expect((stored.blob as Blob).type).toBe("image/jpeg");
      // A small file lives on its record alone.
      expect(storage.files.has(`${staging.database}/${file.id}`)).toBe(false);
    }
  });

  it("small files are written before more than a few of them are held in memory", async () => {
    const staging = await handoffProfileHost("1.1.8", "web").staging.open();
    const bytes = new Uint8Array(12 * 1024 * 1024).fill(7), digest = digestText(sha256(bytes));
    const files = Array.from({ length: 7 }, (_, i) => ({ id: `chat1-in-video${i}`, size: bytes.length, sha256: digest }));
    for (const file of files) storage.files.set(`${staging.database}/${file.id}`, bytes);
    restored.rows = files.map((file) => row(file.id));

    await staging.restore(new Uint8Array(), files);

    // Three files of 12 MiB reach the 32 MiB a transaction takes: 3 + 3 + 1.
    expect(restored.transactions).toHaveLength(3);
    for (const stored of await rowsOf(staging.database)) expect((stored.blob as Blob).size).toBe(bytes.length);
  });

  it("a record keeps its own digest, and a file without a record is left out", async () => {
    const staging = await handoffProfileHost("1.1.8", "web").staging.open();
    const own = "A".repeat(43);
    storage.files.set(`${staging.database}/chat1-in-gone`, new Uint8Array(3));
    restored.rows = [row("chat1-in-kept", { digest: own, bytes: "idb" })];

    await staging.restore(new Uint8Array(), [{ id: "chat1-in-gone", size: 3, sha256: "B".repeat(43) }, { id: "chat1-in-kept", size: SMALL_FILE_BYTES + 1, sha256: "C".repeat(43) }]);

    const rows = await rowsOf(staging.database);
    expect(rows.map((value) => [value.id, value.digest, value.bytes])).toEqual([["chat1-in-kept", own, "opfs"]]);
  });

  it("a staged file shorter than it says stops the restore", async () => {
    const staging = await handoffProfileHost("1.1.8", "web").staging.open();
    storage.files.set(`${staging.database}/chat1-in-cut`, new Uint8Array(2));
    restored.rows = [row("chat1-in-cut")];
    await expect(staging.restore(new Uint8Array(), [{ id: "chat1-in-cut", size: 3, sha256: "B".repeat(43) }])).rejects.toThrow("shorter");
  });
});
