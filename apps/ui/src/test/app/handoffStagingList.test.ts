import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { digestText, registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import type { HandoffFile } from "@ghostly/browser/devices/handoff";
import { handoffProfileHost } from "../../lib/handoffProfile";
import { namespaceOf, registryKey } from "../../lib/profiles";
// covers: devices.handoff

/*
 * The note of which files a taker's staging holds whole and checked (WISP 06 § The handoff): what a pull that stopped
 * goes on from. It was one list under one key, read, parsed, written again whole for every file that began and for
 * every file that finished: a profile of 2,000 files moved 0.77 GB of text through the page's storage, on the page's
 * main thread, and the cost of each file grew with the files before it (bug hunt, 2026-10-09). Then each file had its
 * own localStorage key, which filled the origin's fixed localStorage cap at about 20k files on WebKit (bug hunt,
 * 2026-11-06). Each file has its own record in IndexedDB now: the same cost for the first or the five-thousandth file,
 * and no cap but the disk's.
 */

/** File storage as the origin-private file system keeps it: one folder per profile space. */
function folders(): FileBytes {
  const files = new Map<string, Uint8Array>();
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    append: async (id: string, _offset: number, bytes: Uint8Array) => { files.set(`${space}/${id}`, bytes); },
    flush: async () => {},
    close: async () => {},
    size: async (id: string) => files.get(`${space}/${id}`)?.length ?? null,
    digest: async (id: string) => digestText(sha256(files.get(`${space}/${id}`)!)),
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return view("ghostly");
}

const bytes = new Uint8Array(3);
// The bytes' own digest: a page that reopens the staging checks the small files against it.
const fileOf = (n: number): HandoffFile => ({ id: `chat${n % 40}-in-${String(n).padStart(6, "0")}-photo`, size: 3, sha256: digestText(sha256(bytes)) });
const legacyKey = (database: string) => `ghostly-staging:${database.replace(/^ghostly_/, "")}`;
const byId = (a: HandoffFile, b: HandoffFile) => (a.id < b.id ? -1 : 1);
const stagingKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith("ghostly-staging:"));

beforeEach(async () => {
  localStorage.clear();
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly");
  const store = folders();
  registerFileBytes("opfs", async () => store);
  resetFileBytes(["opfs"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  registerFileBytes("opfs", async () => null);
  resetFileBytes();
  localStorage.clear();
});

describe("the note of the files a taker's staging holds", () => {
  it("costs the same for each file, however many files are staged already", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    // As one list: 473,421 characters for the first 50 files, 11,006,010 for the 550th to the 600th.
    const puts = vi.spyOn(IDBObjectStore.prototype, "put"), lists = vi.spyOn(IDBObjectStore.prototype, "getAll");
    for (let n = 0; n < 600; n++) { const file = fileOf(n); await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file); }

    // A file that finishes writes its own note once, and nothing reads the others'.
    expect(puts).toHaveBeenCalledTimes(600);
    expect(lists).not.toHaveBeenCalled();
    expect((await staging.held()).length).toBe(600);
  });

  it("stages a move's files when the origin's localStorage is full", async () => {
    // localStorage has a fixed cap per origin, whatever the disk holds: about 2.6M characters on WebKit, 5.2M on
    // Chromium. A note of 124 characters per file filled it at about 20k files on an iPhone, and the move failed with
    // "Not enough space on this device" with 10 GB of quota free (bug hunt, 2026-11-06).
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    const writes = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });
    const files = Array.from({ length: 50 }, (_, n) => fileOf(n));
    try {
      for (const file of files) { await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file); }
      expect((await staging.held()).sort(byId)).toEqual(files.sort(byId));
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); }
  });

  it("lists what was finished, and no longer a file that began again or was discarded", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    const [a, b, c] = [fileOf(1), fileOf(2), fileOf(3)];
    for (const file of [a, b, c]) { await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file); }
    expect((await staging.held()).sort(byId)).toEqual([a, b, c]);

    await staging.discard(b.id);
    await staging.begin([c.id]);
    expect(await staging.held()).toEqual([a]);

    // The same namespace opened again (the page reloaded): the note is on the device, not in the page.
    const again = await handoffProfileHost("1.1.7", "web").staging.open(staging.database);
    expect(await again.held()).toEqual([a]);
  });

  it("goes on from the one list an earlier build wrote, and keeps none of it once the namespace is dropped", async () => {
    const host = handoffProfileHost("1.1.7", "web");
    const staging = await host.staging.open();
    const [a, b, c] = [fileOf(1), fileOf(2), fileOf(3)];
    localStorage.setItem(legacyKey(staging.database), JSON.stringify([a, b]));

    expect((await staging.held()).sort(byId)).toEqual([a, b]);
    await staging.discard(a.id);
    await staging.begin([c.id]); await staging.append(c.id, 0, bytes); await staging.finish(c);
    expect((await staging.held()).sort(byId)).toEqual([b, c]);

    await host.staging.drop(staging.database);
    expect(await (await host.staging.open(staging.database)).held()).toEqual([]);
    expect(stagingKeys()).toEqual([]);
  });

  it("goes on from the notes the previous build kept in localStorage, one key per file, a held Blob's included", async () => {
    const host = handoffProfileHost("1.1.7", "web");
    const staging = await host.staging.open();
    const [a, b, c] = [fileOf(1), fileOf(2), fileOf(3)];
    const ns = staging.database.replace(/^ghostly_/, "");
    localStorage.setItem(`ghostly-staging:${ns}:${a.id}`, JSON.stringify({ size: a.size, sha256: a.sha256 }));
    localStorage.setItem(`ghostly-staging:${ns}:${b.id}`, JSON.stringify({ size: b.size, sha256: b.sha256, held: { database: "ghostly", id: "old-b" } }));

    expect((await staging.held()).sort(byId)).toEqual([a, b]);
    expect(stagingKeys()).toEqual([]);
    // The held Blob's note still says where its bytes are: a copy of it under another id is left there too.
    await staging.copyStaged(b.id, c);
    expect((await staging.held()).sort(byId)).toEqual([a, b, c]);
    expect(await (await host.staging.open(staging.database)).held()).toHaveLength(3);
  });

  it("keeps another namespace's files apart, one whose name begins the same included", async () => {
    const host = handoffProfileHost("1.1.7", "web");
    const one = await host.staging.open("ghostly_stage"), other = await host.staging.open("ghostly_stage.2");
    const [a, b] = [fileOf(1), fileOf(2)];
    await one.begin([a.id]); await one.append(a.id, 0, bytes); await one.finish(a);
    await other.begin([b.id]); await other.append(b.id, 0, bytes); await other.finish(b);

    expect(await one.held()).toEqual([a]);
    expect(await other.held()).toEqual([b]);
    await host.staging.drop("ghostly_stage");
    expect(await other.held()).toEqual([b]);
  });

  it("keeps none of a move's notes once its namespace is installed: they only served a pull that had not finished", async () => {
    localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: "", profiles: [{ id: "", name: "Personal", createdAt: 0 }] }));
    const host = handoffProfileHost("1.1.7", "web");
    const staging = await host.staging.open(), unfinished = await host.staging.open("ghostly_stage");
    for (let n = 0; n < 1_000; n++) { const file = fileOf(n); await staging.begin([file.id]); await staging.append(file.id, 0, bytes); await staging.finish(file); }
    await unfinished.begin([fileOf(1).id]); await unfinished.append(fileOf(1).id, 0, bytes); await unfinished.finish(fileOf(1));

    // The install, then the take drops the old namespace (bug hunt, 2026-11-04: 1,000 keys, 125,690 characters left).
    await host.staging.install("ghostly", staging.database);
    await host.staging.drop("ghostly");

    expect(namespaceOf("")).toBe(staging.database.replace(/^ghostly_/, ""));
    expect(await (await host.staging.open(staging.database)).held()).toEqual([]);
    // Another staging, not installed, still goes on from its own.
    expect(await unfinished.held()).toEqual([fileOf(1)]);
  });
});
