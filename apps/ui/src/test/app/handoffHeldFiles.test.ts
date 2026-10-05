import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { digestText, registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * The files a taker's frozen copy already holds (WISP 06 § The handoff: "what the frozen copy holds is copied in here,
 * not sent"). The taker tells the giver it holds them, so the giver never sends them, and copies them into its staging
 * itself. A file up to 16 MiB is kept whole as a Blob on its record, not in file storage: the copy read only file
 * storage, failed, and every move back to a device that held a small file (a photo in a chat) ended "The copy was
 * damaged" (bug hunt r9a, 2026-10-05).
 */

/** File storage as the origin-private file system keeps it: one folder per profile space. */
function folders() {
  const files = new Map<string, Uint8Array>();
  const view = (space: string): FileBytes => ({
    kind: "opfs",
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
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), files };
}

/** The frozen copy's peer database: its file records as the app stores them (Node's Blob: fake-indexeddb clones it whole, happy-dom's it does not). */
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

const dropAll = async () => {
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};

let storage: ReturnType<typeof folders>;
beforeEach(async () => {
  await dropAll();
  setDatabaseName("ghostly");
  storage = folders();
  registerFileBytes("opfs", async () => storage.store);
  resetFileBytes(["opfs"]);
});
afterEach(async () => {
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  await dropAll();
});

describe("a taker copies the files its frozen copy holds into its staging", () => {
  it("a small file kept as a Blob on its record", async () => {
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);
    const digest = digestText(sha256(bytes));
    await frozenCopy([{ id: "chat1-out-photo", linkId: "chat1", direction: "out", blob: new NodeBlob([bytes]), digest, createdAt: 1, metadata: { name: "photo.jpg", size: bytes.length, mime: "image/jpeg", timestamp: 1 } }]);
    const staging = await handoffProfileHost("1.1.2", "web").staging.open();
    const file = { id: "chat1-out-photo", size: bytes.length, sha256: digest };

    await staging.copyHeld("chat1-out-photo", file);

    expect(await staging.held()).toEqual([file]);
    expect(storage.files.get(`${staging.database}/chat1-out-photo`)).toEqual(bytes);
  });

  it("a large file in file storage", async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 13) % 241);
    const digest = digestText(sha256(bytes));
    await storage.store.append("chat1-in-video", 0, bytes);
    await frozenCopy([{ id: "chat1-in-video", linkId: "chat1", direction: "in", bytes: "opfs", digest, createdAt: 1, metadata: { name: "video.mp4", size: bytes.length, mime: "video/mp4", timestamp: 1 } }]);
    const staging = await handoffProfileHost("1.1.2", "web").staging.open();
    const file = { id: "chat1-in-video", size: bytes.length, sha256: digest };

    await staging.copyHeld("chat1-in-video", file);

    expect(await staging.held()).toEqual([file]);
    expect(storage.files.get(`${staging.database}/chat1-in-video`)).toEqual(bytes);
  });

  it("a file the frozen copy does not hold is not noted as staged", async () => {
    await frozenCopy([]);
    const staging = await handoffProfileHost("1.1.2", "web").staging.open();
    await expect(staging.copyHeld("gone", { id: "gone", size: 3, sha256: digestText(sha256(new Uint8Array(3))) })).rejects.toThrow();
    expect(await staging.held()).toEqual([]);
  });
});
