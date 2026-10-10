import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import type { HandoffFile } from "@ghostly/browser/devices/handoff";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * The note of which files a taker's staging holds whole and checked (WISP 06 § The handoff): what a pull that stopped
 * goes on from. It was one list under one key, read, parsed, written again whole for every file that began and for
 * every file that finished: a profile of 2,000 files moved 0.77 GB of text through the page's storage, on the page's
 * main thread, and the cost of each file grew with the files before it (bug hunt, 2026-10-09). Each file has its own
 * key now, so a file costs the same whether it is the first or the five-thousandth.
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
    remove: async (id: string) => { files.delete(`${space}/${id}`); },
    removeWhere: async () => {},
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return view("ghostly");
}

const fileOf = (n: number): HandoffFile => ({ id: `chat${n % 40}-in-${String(n).padStart(6, "0")}-photo`, size: 3, sha256: String(n).padStart(43, "A") });
const bytes = new Uint8Array(3);
const legacyKey = (database: string) => `ghostly-staging:${database.replace(/^ghostly_/, "")}`;
const byId = (a: HandoffFile, b: HandoffFile) => (a.id < b.id ? -1 : 1);

beforeEach(() => {
  localStorage.clear();
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
    let moved = 0;
    const get = localStorage.getItem.bind(localStorage), set = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => { const value = get(key); moved += value?.length ?? 0; return value; });
    const writes = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => { moved += value.length; set(key, value); });
    const stage = async (from: number, to: number) => {
      const before = moved;
      for (let n = from; n < to; n++) { const file = fileOf(n); await staging.begin(file.id); await staging.append(file.id, 0, bytes); await staging.finish(file); }
      return moved - before;
    };

    const first = await stage(0, 50);
    await stage(50, 550);
    const last = await stage(550, 600);

    // As one list: 473,421 characters for the first 50 files, 11,006,010 for these 50. Now 3,250 for either.
    expect(last).toBeLessThanOrEqual(first * 2);
    // A file that begins writes nothing, one that finishes writes once.
    expect(writes).toHaveBeenCalledTimes(600);
    expect((await staging.held()).length).toBe(600);
  });

  it("lists what was finished, and no longer a file that began again or was discarded", async () => {
    const staging = await handoffProfileHost("1.1.7", "web").staging.open();
    const [a, b, c] = [fileOf(1), fileOf(2), fileOf(3)];
    for (const file of [a, b, c]) { await staging.begin(file.id); await staging.append(file.id, 0, bytes); await staging.finish(file); }
    expect((await staging.held()).sort(byId)).toEqual([a, b, c]);

    await staging.discard(b.id);
    await staging.begin(c.id);
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
    await staging.begin(c.id); await staging.append(c.id, 0, bytes); await staging.finish(c);
    expect((await staging.held()).sort(byId)).toEqual([b, c]);

    await host.staging.drop(staging.database);
    expect(await (await host.staging.open(staging.database)).held()).toEqual([]);
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key) => key?.startsWith("ghostly-staging:"))).toEqual([]);
  });

  it("keeps another namespace's files apart, one whose name begins the same included", async () => {
    const host = handoffProfileHost("1.1.7", "web");
    const one = await host.staging.open("ghostly_stage"), other = await host.staging.open("ghostly_stage.2");
    const [a, b] = [fileOf(1), fileOf(2)];
    await one.begin(a.id); await one.append(a.id, 0, bytes); await one.finish(a);
    await other.begin(b.id); await other.append(b.id, 0, bytes); await other.finish(b);

    expect(await one.held()).toEqual([a]);
    expect(await other.held()).toEqual([b]);
    await host.staging.drop("ghostly_stage");
    expect(await other.held()).toEqual([b]);
  });
});
