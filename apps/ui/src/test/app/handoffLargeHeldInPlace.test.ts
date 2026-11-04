import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { SMALL_FILE_BYTES, digestText, registerFileBytes, resetFileBytes, type FileBytes, type FileBytesKind } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { databaseOfSpace } from "../../lib/profiles";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * A move back to a device whose frozen copy holds files over 16 MiB (WISP 06 § Installing the staged state: "Files `B`
 * already held are linked into it, not copied"). Each one was copied byte by byte into the staging's file storage and
 * hashed: a device's videos written whole at every move back. Where file storage can give a file a second name
 * (Desktop's real files), the staged profile gets one: nothing is written or read, and the frozen copy keeps its own.
 */

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

/**
 * File storage by space, counting the bytes written and read. `linking`: names in two spaces can share one file, as
 * Desktop's hard links do (`link`); `failing` makes each link fail, as on a disk that has none.
 */
function storage(kind: FileBytesKind, linking: boolean) {
  /** Each file as the steps it was written in: a file is one list, a second name of it the same list. */
  const files = new Map<string, Uint8Array[]>();
  const calls = { written: 0, read: 0, linked: 0, failing: false };
  const sizeOf = (parts: Uint8Array[]) => parts.reduce((sum, part) => sum + part.length, 0);
  const view = (space: string): FileBytes => ({
    kind,
    append: async (id: string, offset: number, bytes: Uint8Array) => {
      const key = `${space}/${id}`, had = files.get(key) ?? [];
      if (sizeOf(had) !== offset) throw new Error("File write out of order");
      files.set(key, [...had, bytes.slice()]);
      calls.written += bytes.length;
    },
    flush: async () => {},
    close: async () => {},
    size: async (id: string) => { const held = files.get(`${space}/${id}`); return held ? sizeOf(held) : null; },
    read: async (id: string, offset: number, length: number) => {
      const held = files.get(`${space}/${id}`);
      if (!held) throw new Error("No such file");
      const out: Uint8Array[] = [];
      let at = 0;
      for (const part of held) {
        const from = Math.max(offset, at), to = Math.min(offset + length, at + part.length);
        if (from < to) out.push(part.subarray(from - at, to - at));
        at += part.length;
      }
      const part = new Uint8Array(out.reduce((sum, piece) => sum + piece.length, 0));
      out.reduce((done, piece) => { part.set(piece, done); return done + piece.length; }, 0);
      calls.read += part.length;
      return part;
    },
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    dropSpace: async (other: string) => { for (const key of [...files.keys()]) if (key.startsWith(`${other}/`)) files.delete(key); },
    forSpace: (other: string) => view(other),
    ...(linking ? {
      link: async (fromSpace: string, fromId: string, id: string) => {
        const held = files.get(`${fromSpace}/${fromId}`);
        if (calls.failing || !held) throw new Error("Operation not permitted");
        files.set(`${space}/${id}`, held);
        calls.linked++;
      },
    } : {}),
  } as unknown as FileBytes);
  /** The digest of what is stored under `space/id`, or null when nothing is. */
  const digestAt = (key: string) => {
    const held = files.get(key);
    if (!held) return null;
    const hash = sha256.create();
    for (const part of held) hash.update(part);
    return digestText(hash.digest());
  };
  return { store: view("ghostly"), files, calls, digestAt };
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

/** Three videos just over 16 MiB, kept in the frozen copy's file storage with their checked digests. */
async function videos(store: ReturnType<typeof storage>, kind: FileBytesKind, recordDigest?: string) {
  const held = Array.from({ length: 3 }, (_, i) => {
    const bytes = new Uint8Array(SMALL_FILE_BYTES + 1024 * (i + 1)).fill(i + 1);
    return { id: `chat1-in-${i}`, bytes, digest: digestText(sha256(bytes)) };
  });
  const record = (file: (typeof held)[number]) => ({ id: file.id, linkId: "chat1", direction: "in", digest: recordDigest ?? file.digest, createdAt: 1, metadata: { name: "video.mp4", size: file.bytes.length, mime: "video/mp4", timestamp: 1 } });
  for (const file of held) store.files.set(`ghostly/${file.id}`, [file.bytes]);
  await frozenCopy(held.map((file) => ({ ...record(file), bytes: kind })));
  restored.rows = held.map(record);
  return { held, files: held.map((file) => ({ id: file.id, size: file.bytes.length, sha256: file.digest })) };
}

let files: ReturnType<typeof storage>;
const use = (kind: FileBytesKind, linking: boolean) => {
  files = storage(kind, linking);
  registerFileBytes(kind, async () => files.store, true);
  resetFileBytes([kind]);
};
beforeEach(async () => {
  await dropAll();
  setDatabaseName("ghostly");
  restored.rows = [];
});
afterEach(async () => {
  for (const kind of ["native", "opfs"] as const) registerFileBytes(kind, async () => null);
  resetFileBytes();
  await dropAll();
});

describe("a move back keeps the files over 16 MiB the frozen copy holds where they are", () => {
  it("Desktop: each one is linked into the staged profile, nothing written or read, and the frozen copy keeps its own", async () => {
    use("native", true);
    const { held, files: list } = await videos(files, "native");
    const staging = await handoffProfileHost("1.9.0", "desktop").staging.open();

    await staging.copyHeld(list.map((file) => ({ fromId: file.id, file })));
    expect(await staging.held()).toEqual(list);
    await staging.restore(new Uint8Array(), list);

    expect(files.calls).toMatchObject({ written: 0, read: 0, linked: 3 });
    const rows = new Map((await rowsOf(staging.database)).map((value) => [value.id as string, value]));
    expect(held.map((file) => [rows.get(file.id)?.bytes, rows.get(file.id)?.digest])).toEqual(held.map((file) => ["native", file.digest]));
    const space = staging.database;
    expect(held.map((file) => [files.digestAt(`${space}/${file.id}`), files.digestAt(`ghostly/${file.id}`)])).toEqual(held.map((file) => [file.digest, file.digest]));

    // A revert before install drops the staged profile: the frozen copy still has every file.
    await handoffProfileHost("1.9.0", "desktop").staging.drop(space);
    expect(held.map((file) => files.digestAt(`ghostly/${file.id}`))).toEqual(held.map((file) => file.digest));
    expect([...files.files.keys()].filter((key) => key.startsWith(`${space}/`))).toEqual([]);
  });

  it("a link that fails (a disk with none) copies and checks the file as before", async () => {
    use("native", true);
    files.calls.failing = true;
    const { held, files: list } = await videos(files, "native");
    const staging = await handoffProfileHost("1.9.0", "desktop").staging.open();

    await staging.copyHeld(list.map((file) => ({ fromId: file.id, file })));

    expect(await staging.held()).toEqual(list);
    expect(files.calls.written).toBe(held.reduce((sum, file) => sum + file.bytes.length, 0));
    expect(held.map((file) => files.digestAt(`${staging.database}/${file.id}`))).toEqual(held.map((file) => file.digest));
  });

  it("a record that names another digest than the file's is not linked: copied and checked as before", async () => {
    use("native", true);
    const { held, files: list } = await videos(files, "native", "A".repeat(43));
    const staging = await handoffProfileHost("1.9.0", "desktop").staging.open();

    await staging.copyHeld(list.map((file) => ({ fromId: file.id, file })));

    expect(files.calls.linked).toBe(0);
    expect(files.calls.written).toBe(held.reduce((sum, file) => sum + file.bytes.length, 0));
    expect(await staging.held()).toEqual(list);
  });

  it("storage with no second names (the origin-private file system) still copies and checks each one", async () => {
    use("opfs", false);
    const { held, files: list } = await videos(files, "opfs");
    const staging = await handoffProfileHost("1.9.0", "web").staging.open();

    await staging.copyHeld(list.map((file) => ({ fromId: file.id, file })));

    expect(await staging.held()).toEqual(list);
    expect(files.calls.written).toBe(held.reduce((sum, file) => sum + file.bytes.length, 0));
  });
});
