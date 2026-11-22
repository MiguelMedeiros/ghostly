import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { SMALL_FILE_BYTES, digestText, registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import type { HandoffFile } from "@ghostly/browser/devices/handoff";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * What a taker's staging asks of the disk per file it takes (WISP 06 § The handoff). Each file was forced to disk as it
 * finished (a flush with the close), its size looked up once it was closed, and the files of a pass began one round
 * trip at a time: 3,000 files of 4 KB took 21 to 37 s of pass 1 where the same 12 MB as one file took 1.6 s (bug hunt,
 * 2026-11-13). The counts are what is tested, not the time.
 */

/** File storage as the origin-private file system keeps it, counting the writes it forces to disk. */
function folders() {
  const files = new Map<string, Uint8Array>(), open = new Set<string>();
  const counts = { forced: 0, closedSizes: 0, removes: 0, digests: 0 };
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    append: async (id: string, offset: number, bytes: Uint8Array) => {
      const key = `${space}/${id}`, had = files.get(key) ?? new Uint8Array();
      if (had.length !== offset) throw new Error("File write out of order");
      const next = new Uint8Array(had.length + bytes.length);
      next.set(had); next.set(bytes, had.length);
      files.set(key, next); open.add(key);
    },
    flush: async () => { counts.forced += 1; },
    close: async (id: string, flush = true) => { if (open.delete(`${space}/${id}`) && flush) counts.forced += 1; },
    size: async (id: string) => { if (!open.has(`${space}/${id}`)) counts.closedSizes += 1; return files.get(`${space}/${id}`)?.length ?? null; },
    digest: async (id: string) => { counts.digests += 1; return digestText(sha256(files.get(`${space}/${id}`) ?? new Uint8Array())); },
    remove: async (id: string) => { counts.removes += 1; open.delete(`${space}/${id}`); files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), files, counts };
}

const fileOf = (n: number, bytes: Uint8Array): HandoffFile => ({ id: `chat${n % 40}-in-${String(n).padStart(6, "0")}-voice`, size: bytes.length, sha256: digestText(sha256(bytes)) });
const bytesOf = (n: number, size = 4_096) => new Uint8Array(size).fill(n % 251);
const byId = (a: HandoffFile, b: HandoffFile) => (a.id < b.id ? -1 : 1);
let disk: ReturnType<typeof folders>;

beforeEach(async () => {
  localStorage.clear();
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly");
  disk = folders();
  registerFileBytes("opfs", async () => disk.store);
  resetFileBytes(["opfs"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  localStorage.clear();
});

describe("what a taker's staging asks of the disk per file", () => {
  it("stages a pass of small files with no write forced to disk, one notes transaction to begin them all and one note each", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    await staging.held();
    const files = Array.from({ length: 300 }, (_, n) => ({ file: fileOf(n, bytesOf(n)), bytes: bytesOf(n) }));
    const writes = vi.spyOn(IDBDatabase.prototype, "transaction");
    const readwrite = () => writes.mock.calls.filter(([, mode]) => mode === "readwrite").length;

    await staging.begin(files.map(({ file }) => file.id));
    expect(readwrite()).toBe(1);
    expect(disk.counts.removes).toBe(300);
    for (const { file, bytes } of files) { await staging.append(file.id, 0, bytes); await staging.finish(file); }

    expect(disk.counts.forced).toBe(0);
    expect(disk.counts.closedSizes).toBe(0);
    expect(readwrite()).toBe(1 + 300);
    // In the page that staged them they are whole: nothing is read back.
    expect((await staging.held()).sort(byId)).toEqual(files.map(({ file }) => file).sort(byId));
    expect(disk.counts.digests).toBe(0);
  });

  it("still forces a large file to disk before its note: a later page does not read it back", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    const bytes = bytesOf(1, SMALL_FILE_BYTES + 1), file = fileOf(1, bytes);
    await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file);
    expect(disk.counts.forced).toBe(1);

    expect(await (await handoffProfileHost("1.1.7", "web").staging.open(staging.database)).held()).toEqual([file]);
    expect(disk.counts.digests).toBe(0);
  });

  it("a later page reads each small file back before it believes its note, and forgets one whose bytes did not reach the disk", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    const [a, b] = [bytesOf(1), bytesOf(2)];
    const [fa, fb] = [fileOf(1, a), fileOf(2, b)];
    for (const [file, bytes] of [[fa, a], [fb, b]] as const) { await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file); }

    // The device went down before b's bytes were on disk: its file is there, empty, as the system left it.
    disk.files.set(`${staging.database}/${fb.id}`, new Uint8Array(b.length));
    const again = await handoffProfileHost("1.1.7", "web").staging.open(staging.database);
    expect(await again.held()).toEqual([fa]);
    expect(disk.counts.digests).toBe(2);
    expect(disk.files.has(`${staging.database}/${fb.id}`)).toBe(false);
    // Checked once per page: a's note is believed from then on.
    expect(await again.held()).toEqual([fa]);
    expect(disk.counts.digests).toBe(2);
  });
});
