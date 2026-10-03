import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { encode } from "../src/backup/codec";
import { snapshotDatabase } from "../src/backup/database";
import { seal } from "../src/backup/envelope";
import { memorySink } from "../src/backup/stream";
import { DB_VERSION, STORES, openDb, transact, wrap } from "../src/shared/idb";
import { SMALL_FILE_BYTES, fileBytes, registerFileBytes, resetFileBytes, type FileBytes } from "../src/shared/fileBytes";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { createProfile, listProfiles } from "../../../apps/ui/src/lib/profiles";
import { backUpToFile, stageBackup } from "../../../apps/ui/src/lib/backupFile";
import { backupProtectionOf, createProfileBackup, isCancelled, openProfileBackup, restoreProfileBackup, writeProfileBackup, type BackupProgress } from "../../../apps/ui/src/lib/profileBackup";
import { sweepInterruptedRestores } from "../../../apps/ui/src/lib/restoreJournal";
// covers: backup.profile.file, backup.stream, backup.unprotected, backup.progress, backup.envelope

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
beforeEach(async () => {
  // Every test starts with no database at all (the open one closes itself when asked to make way).
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  storage = new FakeStorage();
  setStorageProfile("");
  resetFileBytes();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
  // PBKDF2 at the real 600,000 rounds is slow on a loaded machine: fewer here (the rounds are checked in backupStream.test.ts).
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "a long backup passphrase";
const MIB = 1024 * 1024;
const pattern = (length: number, seed: number) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();
async function readAll(dbName: string, store: string) {
  const db = await wrap(indexedDB.open(dbName));
  try { return await wrap(db.transaction(store, "readonly").objectStore(store).getAll()); } finally { db.close(); }
}
/** A restored large file's bytes, read from the pieces the new profile's own database holds. */
async function pieces(dbName: string, id: string): Promise<Uint8Array> {
  const rows = (await readAll(dbName, STORES.fileChunks) as { id: string; index: number; length: number; data: Blob }[]).filter((row) => row.id === id).sort((a, b) => a.index - b.index);
  const parts = await Promise.all(rows.map(async (row) => new Uint8Array(await row.data.arrayBuffer())));
  return Buffer.concat(parts);
}

/** A profile with a chat, a nickname and files: `small` kept as Blobs, `large` in file storage. */
async function seed({ small = 3, large = [] as number[] } = {}) {
  storage.setItem("ghostly_0123456789abcdef0123456789abcdef", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", mySeedB64: "c2VlZA", messages: [] }));
  storage.setItem("ghostly_app_settings", JSON.stringify({ defaultNickname: "Nick Kept Secret" }));
  await openDb();
  await transact([STORES.links, STORES.messages, STORES.files, STORES.settings], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    for (let i = 0; i < 5; i++) s[STORES.messages].put({ linkId: "link1", id: `m${i}`, text: `message ${i}` });
    s[STORES.settings].put({ nick: "Nick Kept Secret" }, "settings");
    for (let i = 0; i < small; i++) s[STORES.files].put({ id: `link1-in-s${i}`, linkId: "link1", blob: new Blob([pattern(1000 + i, i)], { type: "image/png" }), createdAt: i, metadata: { name: `${i}.png`, size: 1000 + i, mime: "image/png", timestamp: i } });
  });
  const store = await fileBytes();
  for (const [i, size] of large.entries()) {
    const id = `link1-in-l${i}`, bytes = pattern(size, 100 + i);
    for (let at = 0; at < size; at += MIB) await store.append(id, at, bytes.subarray(at, at + MIB));
    await store.close(id);
    // Where its bytes are is written after the record, as a finished transfer does it.
    await transact([STORES.files, STORES.fileState], (s) => {
      s[STORES.files].put({ id, linkId: "link1", createdAt: i, direction: "in", metadata: { name: `${i}.mp4`, size, mime: "video/mp4", timestamp: i } });
      s[STORES.fileState].put({ id, bytes: store.kind, transfer: { state: "done", transferred: size, size } });
    });
  }
}

it("a version 1 bundle, as apps before this one made them, still restores whole", async () => {
  await seed();
  // What `createProfileBackup` wrote until now: every store in one JSON document, sealed in the version 1 envelope.
  const peer = await snapshotDatabase("ghostly");
  const bundle = await seal(await encode({ format: "ghostly-profile", version: 1, createdAt: 1, profile: { name: "Diary", builtIn: false }, storage: { app_settings: storage.getItem("ghostly_app_settings")! }, databases: { peer, ark: {} } }), PASS);
  expect(JSON.parse(bundle).version).toBe(1);
  expect(await backupProtectionOf(bundle)).toBe("passphrase");
  await expect(restoreProfileBackup(bundle, "not the passphrase")).rejects.toThrow("Wrong passphrase");
  // As text, as bytes, or as the file a person picks: the same.
  for (const input of [bundle, new TextEncoder().encode(bundle), new Blob([bundle])]) {
    const restored = await restoreProfileBackup(input, PASS);
    expect(restored.name).toBe("Diary (restored)");
    const db = `ghostly_${restored.id}`;
    expect((await readAll(db, STORES.messages)).length).toBe(5);
    const files = await readAll(db, STORES.files) as { id: string; blob: Blob }[];
    expect(files.map((f) => f.id)).toEqual(["link1-in-s0", "link1-in-s1", "link1-in-s2"]);
    expect(same(new Uint8Array(await files[1].blob.arrayBuffer()), pattern(1001, 1))).toBe(true);
    expect(storage.getItem(`ghostly_${restored.id}_app_settings`)).toContain("Nick Kept Secret");
  }
});

it("a profile whose database a newer version made is refused before anything is written, not restored as one this version cannot open", async () => {
  await seed();
  // The profile as a newer app keeps it: its database one version up.
  (await wrap(indexedDB.open("ghostly", DB_VERSION + 1))).close();
  const streamed = await createProfileBackup(null);
  const peer = await snapshotDatabase("ghostly");
  expect(peer?.version).toBe(DB_VERSION + 1);
  const whole = await seal(await encode({ format: "ghostly-profile", version: 1, createdAt: 1, profile: { name: "Diary", builtIn: false }, storage: {}, databases: { peer, ark: {} } }), PASS);
  const before = await databases();
  for (const [bundle, passphrase] of [[streamed, undefined], [whole, PASS]] as const) {
    await expect(openProfileBackup(bundle, passphrase)).rejects.toThrow("This backup comes from a newer Ghostly; update to restore it");
    await expect(restoreProfileBackup(bundle, passphrase)).rejects.toThrow("This backup comes from a newer Ghostly; update to restore it");
    expect(await databases()).toEqual(before);
    expect(listProfiles().map((p) => p.id)).toEqual([""]);
  }
});

it("a profile with many files and large ones comes back whole: every record, every byte, large files in file storage", async () => {
  await seed({ small: 120, large: [SMALL_FILE_BYTES + 3, 2 * MIB] });
  const told: BackupProgress[] = [];
  const sink = memorySink();
  const result = await writeProfileBackup(sink, { passphrase: PASS, onProgress: (p) => told.push(p) });
  const bundle = sink.bytes();
  const fileBytesTotal = Array.from({ length: 120 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0) + SMALL_FILE_BYTES + 3 + 2 * MIB;
  expect(result).toEqual({ bytes: bundle.length, files: 122, fileBytes: fileBytesTotal, skipped: 0 });
  // Sealed: no name, no nickname, no message in the clear.
  const text = new TextDecoder("latin1").decode(bundle.subarray(0, 4 * MIB));
  for (const secret of ["Nick Kept Secret", "message 1", "link1", ".png"]) expect(text).not.toContain(secret);
  // Progress: collecting, then writing, files and bytes counted up to their totals.
  expect(told[0]).toEqual({ stage: "collecting", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 });
  expect(told.find((p) => p.stage === "writing")).toEqual({ stage: "writing", files: 0, filesTotal: 122, bytes: 0, bytesTotal: fileBytesTotal });
  expect(told[told.length - 1]).toEqual({ stage: "writing", files: 122, filesTotal: 122, bytes: fileBytesTotal, bytesTotal: fileBytesTotal });
  expect(told.every((p, i) => i === 0 || (p.bytes >= told[i - 1].bytes && p.files >= told[i - 1].files))).toBe(true);

  const restoring: BackupProgress[] = [];
  const restored = await restoreProfileBackup(new Blob([bundle]), PASS, { onProgress: (p) => restoring.push(p) });
  const db = `ghostly_${restored.id}`;
  expect((await readAll(db, STORES.messages)).length).toBe(5);
  const files = await readAll(db, STORES.files) as { id: string; blob?: Blob; bytes?: string; metadata: { size: number }; transfer?: unknown }[];
  expect(files.length).toBe(122);
  for (let i = 0; i < 120; i++) {
    const file = files.find((f) => f.id === `link1-in-s${i}`)!;
    expect(file.blob!.type).toBe("image/png");
    expect(same(new Uint8Array(await file.blob!.arrayBuffer()), pattern(1000 + i, i)), file.id).toBe(true);
  }
  // Over 16 MiB: in the new profile's file storage, under its own space, not a Blob in a record.
  const big = files.find((f) => f.id === "link1-in-l0")!;
  expect(big.blob).toBeUndefined();
  expect(big.bytes).toBe("idb");
  expect(big.transfer, "what changed about it since it was stored came with its record").toEqual({ state: "done", transferred: SMALL_FILE_BYTES + 3, size: SMALL_FILE_BYTES + 3 });
  expect(same(await pieces(db, "link1-in-l0"), pattern(SMALL_FILE_BYTES + 3, 100))).toBe(true);
  // 2 MiB in file storage on the device it came from: small enough to be a Blob where it is restored.
  const mid = files.find((f) => f.id === "link1-in-l1")!;
  expect(same(new Uint8Array(await mid.blob!.arrayBuffer()), pattern(2 * MIB, 101))).toBe(true);
  expect(await readAll(db, STORES.fileState), "nothing left to read over the records").toEqual([]);
  expect(restoring[0].stage).toBe("opening");
  expect(restoring.some((p) => p.stage === "restoring" && p.filesTotal === 122 && p.bytesTotal === fileBytesTotal)).toBe(true);
  expect(restoring[restoring.length - 1]).toEqual({ stage: "verifying", files: 122, filesTotal: 122, bytes: fileBytesTotal, bytesTotal: fileBytesTotal });
}, 120_000);

it("a backup without a passphrase says so, restores with none, and is still refused when damaged", async () => {
  await seed();
  const bundle = await createProfileBackup(null);
  expect(new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10)))).toBe('{"format":"ghostly-backup","version":2,"protection":"none","check":{"name":"SHA-256-chain"}}');
  expect(await backupProtectionOf(bundle)).toBe("none");
  const opened = await openProfileBackup(bundle);
  expect(opened.protection).toBe("none");
  expect(opened.name).toBe("Personal");

  const damaged = bundle.slice();
  damaged[damaged.length - 200] ^= 1;
  const before = await databases();
  await expect(restoreProfileBackup(damaged)).rejects.toThrow("This backup is damaged");
  await expect(restoreProfileBackup(bundle.slice(0, bundle.length - 37))).rejects.toThrow("This backup is damaged");
  expect(await databases(), "a refused bundle leaves no database").toEqual(before);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);

  const restored = await restoreProfileBackup(bundle);
  expect((await readAll(`ghostly_${restored.id}`, STORES.messages)).length).toBe(5);
  expect((await readAll(`ghostly_${restored.id}`, STORES.files)).length).toBe(3);
});

it("a Blob on a record is the whole file, whatever size its description says", async () => {
  await seed({ small: 0 });
  await transact([STORES.files], (s) => { s[STORES.files].put({ id: "link1-in-odd", linkId: "link1", blob: new Blob([pattern(700, 4)]), createdAt: 1, metadata: { name: "odd.bin", size: 9999, mime: "", timestamp: 1 } }); });
  const sink = memorySink();
  expect(await writeProfileBackup(sink, { passphrase: PASS })).toMatchObject({ files: 1, fileBytes: 700, skipped: 0 });
  const restored = await restoreProfileBackup(sink.bytes(), PASS);
  const [file] = await readAll(`ghostly_${restored.id}`, STORES.files) as { blob: Blob }[];
  expect(same(new Uint8Array(await file.blob.arrayBuffer()), pattern(700, 4))).toBe(true);
});

it("a sealed bundle changed or cut short is refused, and what the restore had written is taken away", async () => {
  await seed({ small: 40 });
  const bundle = await createProfileBackup(PASS);
  const before = await databases();
  const keys = [...storage.entries.keys()].sort();
  // Near the end: the database and most files are written by the time the restore finds out.
  const changed = bundle.slice();
  changed[bundle.length - 60] ^= 1;
  for (const damaged of [changed, bundle.slice(0, bundle.length - 21), bundle.slice(0, Math.floor(bundle.length / 2))]) {
    await expect(restoreProfileBackup(damaged, PASS)).rejects.toThrow("This backup is damaged");
    expect(await databases()).toEqual(before);
    expect([...storage.entries.keys()].sort()).toEqual(keys);
    expect(listProfiles().map((p) => p.id)).toEqual([""]);
  }
});

it("a restore cancelled half way leaves no profile, no database, no file and no key", async () => {
  await seed({ small: 30, large: [SMALL_FILE_BYTES + 1] });
  const bundle = await createProfileBackup(PASS);
  const before = await databases();
  const keys = [...storage.entries.keys()].sort();
  const stop = new AbortController();
  const failure = await restoreProfileBackup(bundle, PASS, { signal: stop.signal, onProgress: (p) => { if (p.stage === "restoring" && p.files >= 10) stop.abort(); } }).catch((error: unknown) => error);
  expect(isCancelled(failure)).toBe(true);
  expect(await databases()).toEqual(before);
  expect([...storage.entries.keys()].sort()).toEqual(keys);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
});

/** Web Locks as a browser keeps them: `drop` lets go of one as a closed tab does, whatever it was doing. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    request: async (name: string, a: unknown, b?: (lock: unknown) => Promise<void> | void) => {
      const callback = (b ?? a) as (lock: unknown) => Promise<void> | void, ifAvailable = !!b && (a as { ifAvailable?: boolean }).ifAvailable;
      if (held.has(name)) { if (ifAvailable) return callback(null); throw new Error("this fake does not queue"); }
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { ...globalThis.navigator, locks }, configurable: true });
  return { held, drop: () => held.clear() };
}

it("a restore whose tab was closed half way leaves nothing for good: the next start takes back what it wrote", async () => {
  const locks = fakeLocks();
  await seed({ small: 200 });
  const bundle = await createProfileBackup(PASS);
  const before = await databases();
  const keys = [...storage.entries.keys()].sort();
  // The tab stops for good half way through the bundle: its database is made and half filled, then nothing more.
  const connections: IDBDatabase[] = [];
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<typeof indexedDB.open>) => { const request = open(...args); request.addEventListener("success", () => connections.push(request.result)); return request; });
  let reached!: () => void;
  const stopped = new Promise<void>((resolve) => { reached = resolve; });
  const source = { size: bundle.length, read: async (offset: number, length: number) => {
    if (offset > bundle.length / 2) { reached(); return new Promise<Uint8Array>(() => {}); }
    return bundle.subarray(offset, offset + Math.min(length, 16 * 1024));
  } };
  void restoreProfileBackup(source, PASS);
  await stopped;
  const left = (await databases()).filter((name) => !before.includes(name!));
  expect(left, "the half-made profile's database is on the device").toHaveLength(1);
  // While that tab still runs, nothing of it is touched.
  await sweepInterruptedRestores();
  expect((await databases()).filter((name) => !before.includes(name!))).toEqual(left);
  // The tab is closed: its connections and its lock go with it. The next start takes back what it left.
  for (const db of connections) db.close();
  locks.drop();
  await sweepInterruptedRestores();
  expect(await databases()).toEqual(before);
  expect([...storage.entries.keys()].sort()).toEqual(keys);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
  // A restore that finished is never taken back.
  const restored = await restoreProfileBackup(bundle, PASS);
  await sweepInterruptedRestores();
  expect((await readAll(`ghostly_${restored.id}`, STORES.messages)).length).toBe(5);
  // Where the page cannot have a lock, a restore still runs, and nothing is taken back.
  Object.defineProperty(globalThis, "navigator", { value: { ...globalThis.navigator, locks: { request: () => Promise.reject(new DOMException("denied", "SecurityError")) } }, configurable: true });
  const second = await restoreProfileBackup(bundle, PASS);
  await sweepInterruptedRestores();
  expect((await readAll(`ghostly_${second.id}`, STORES.messages)).length).toBe(5);
});

/**
 * File storage that behaves as the origin-private file system does: one folder per profile space, and a folder is not
 * removed while a file in it is still open for writing.
 */
function foldersOfFiles() {
  const files = new Map<string, Uint8Array>(), open = new Set<string>();
  const view = (space: string): FileBytes => ({
    kind: "opfs",
    append: async (id: string, offset: number, bytes: Uint8Array) => {
      const key = `${space}/${id}`, had = files.get(key) ?? new Uint8Array();
      if (had.length !== offset) throw new Error("File write out of order");
      const next = new Uint8Array(had.length + bytes.length);
      next.set(had); next.set(bytes, had.length);
      files.set(key, next); open.add(key);
    },
    flush: async () => {},
    close: async (id: string) => { open.delete(`${space}/${id}`); },
    size: async (id: string) => files.get(`${space}/${id}`)?.length ?? null,
    read: async (id: string, offset: number, length: number) => files.get(`${space}/${id}`)!.slice(offset, offset + length),
    remove: async (id: string) => { open.delete(`${space}/${id}`); files.delete(`${space}/${id}`); },
    removeWhere: async (prefix: string) => { for (const key of [...files.keys()]) if (key.startsWith(`${space}/${prefix}`)) { open.delete(key); files.delete(key); } },
    dropSpace: async (target: string) => {
      if ([...open].some((key) => key.startsWith(`${target}/`))) throw new DOMException("A file in this folder is open", "NoModificationAllowedError");
      for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
    },
    forSpace: (other: string) => view(other),
  } as unknown as FileBytes);
  return { store: view("ghostly"), names: () => [...files.keys()].sort() };
}

it("a restore that stops in the middle of a large file leaves none of it in file storage", async () => {
  const folders = foldersOfFiles();
  registerFileBytes("opfs", async () => folders.store);
  onTestFinished(() => registerFileBytes("opfs", async () => null));
  await seed({ small: 3, large: [SMALL_FILE_BYTES + 5 * MIB] });
  const bundle = await createProfileBackup(PASS);
  const before = await databases();
  expect(folders.names()).toEqual(["ghostly/link1-in-l0"]);
  // Cut inside the large file, which comes first: the restore is writing it when it finds the bundle ends.
  await expect(restoreProfileBackup(bundle.slice(0, 8 * MIB), PASS)).rejects.toThrow("This backup is damaged");
  expect(folders.names(), "the half-written file is gone with the rest").toEqual(["ghostly/link1-in-l0"]);
  expect(await databases()).toEqual(before);
  // Cancelled while it is being written: the same.
  const stop = new AbortController();
  const failure = await restoreProfileBackup(bundle, PASS, { signal: stop.signal, onProgress: (p) => { if (p.stage === "restoring" && p.bytes >= 4 * MIB) stop.abort(); } }).catch((error: unknown) => error);
  expect(isCancelled(failure)).toBe(true);
  expect(folders.names()).toEqual(["ghostly/link1-in-l0"]);
  expect(await databases()).toEqual(before);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
  // And whole, it comes back whole, in the new profile's own folder.
  const restored = await restoreProfileBackup(bundle, PASS);
  expect(folders.names()).toEqual(["ghostly/link1-in-l0", `ghostly_${restored.id}/link1-in-l0`]);
  expect(same(await folders.store.forSpace!(`ghostly_${restored.id}`).read("link1-in-l0", 0, SMALL_FILE_BYTES + 5 * MIB), pattern(SMALL_FILE_BYTES + 5 * MIB, 100))).toBe(true);
}, 120_000);

it("a backup cancelled half way, or whose save dialog was closed, leaves no half-written file", async () => {
  await seed({ small: 30, large: [3 * MIB] });
  const staged = async () => (await readAll("ghostly", STORES.fileChunks) as { id: string }[]).filter((row) => row.id.startsWith("save-"));
  const stop = new AbortController();
  const failure = await backUpToFile({ passphrase: PASS, signal: stop.signal, onProgress: (p) => { if (p.files >= 10) stop.abort(); } }, "x.ghostly-backup").catch((error: unknown) => error);
  expect(isCancelled(failure)).toBe(true);
  expect(await staged()).toEqual([]);

  // Staged whole, then the save is declined (the desktop app's dialog closed): gone too.
  const store = await fileBytes();
  Object.assign(store, { save: vi.fn(async () => false) });
  const { how } = await backUpToFile({ passphrase: PASS }, "x.ghostly-backup");
  expect(how).toBe("cancelled");
  expect(await staged()).toEqual([]);

  // Saved: the dialog gets the file's name, and the copy goes once it answered.
  const save = vi.fn(async (_id: string, _name: string) => true);
  Object.assign(store, { save });
  const done = await backUpToFile({ passphrase: PASS }, "Diary.ghostly-backup");
  expect(done.how).toBe("saved");
  expect(save).toHaveBeenCalledWith(expect.stringMatching(/^save-backup-/), "Diary.ghostly-backup");
  expect(done.result.files).toBe(31);
  expect(await staged()).toEqual([]);
  delete (store as { save?: unknown }).save;

  // What the staged copy holds is the bundle itself: read back, it restores.
  const again = await stageBackup();
  await writeProfileBackup(again, { passphrase: PASS });
  const restored = await restoreProfileBackup(await again.bytes(), PASS);
  await again.discard();
  expect((await readAll(`ghostly_${restored.id}`, STORES.files)).length).toBe(31);
  expect(await staged()).toEqual([]);
});

it("a backup whose bundle cannot be written fails: it never leaves the file out and goes on", async () => {
  await seed({ small: 3, large: [3 * MIB] });
  // The store takes everything but one frame of the large file's bytes (no room at that moment), then takes the rest.
  for (const passphrase of [PASS, null]) {
    const sink = memorySink();
    let refused = false;
    const flaky = { write: async (bytes: Uint8Array) => { if (!refused && bytes.length >= MIB) { refused = true; throw Object.assign(new Error("no space left"), { name: "QuotaExceededError" }); } await sink.write(bytes); } };
    // Before: the file was counted as one "that could not be read", the backup was said to be made, and the bundle,
    // a frame short, was refused as damaged by every restore.
    await expect(writeProfileBackup(flaky, { passphrase })).rejects.toThrow("no space left");
    expect(refused).toBe(true);
  }
});

it("a backup that runs out of room on the device says so, and leaves no half-written file", async () => {
  await seed({ small: 3, large: [3 * MIB] });
  const store = await fileBytes();
  const append = store.append.bind(store);
  // Room for the first megabyte of the bundle, then the browser's own error, as file storage hands it on.
  let written = 0;
  vi.spyOn(store, "append").mockImplementation(async (id, offset, bytes) => {
    if (id.startsWith("save-") && (written += bytes.length) > MIB) throw Object.assign(new Error("This device has no space left for the file"), { name: "QuotaExceededError" });
    return append(id, offset, bytes);
  });
  await expect(backUpToFile({ passphrase: PASS }, "x.ghostly-backup")).rejects.toThrow("This device has no room left for this backup. Free some space, then try again.");
  expect((await readAll("ghostly", STORES.fileChunks) as { id: string }[]).filter((row) => row.id.startsWith("save-"))).toEqual([]);
});

it("where storage cannot keep a byte (a private window), the bundle is made in memory instead of failing", async () => {
  await seed();
  const store = await fileBytes();
  // WebKit's private windows: "Error preparing Blob/File data to be stored in object store".
  vi.spyOn(store, "flush").mockRejectedValue(new DOMException("Error preparing Blob/File data to be stored in object store", "DataCloneError"));
  const append = vi.spyOn(store, "append");
  const staged = await stageBackup();
  append.mockClear();
  const result = await writeProfileBackup(staged, { passphrase: PASS });
  expect(append, "nothing more is asked of the storage that refused").not.toHaveBeenCalled();
  expect(staged.size).toBe(result.bytes);
  const restored = await restoreProfileBackup(await staged.bytes(), PASS);
  expect((await readAll(`ghostly_${restored.id}`, STORES.files)).length).toBe(3);
  await staged.discard();
});

it("a file this device can no longer read is left out and counted, not the whole backup", async () => {
  await seed({ small: 4 });
  // WebKit can lose the file behind a stored Blob: every read of it then fails.
  const lost = Blob.prototype.slice;
  vi.spyOn(Blob.prototype, "slice").mockImplementation(function (this: Blob, ...args: Parameters<Blob["slice"]>) {
    if (this.size === 1002) return { arrayBuffer: () => Promise.reject(new DOMException("The object can not be found here.", "NotFoundError")) } as unknown as Blob;
    return lost.apply(this, args);
  });
  const sink = memorySink();
  const result = await writeProfileBackup(sink, { passphrase: PASS });
  vi.restoreAllMocks();
  expect(result.files).toBe(3);
  expect(result.skipped).toBe(1);
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  const restored = await restoreProfileBackup(sink.bytes(), PASS);
  const files = await readAll(`ghostly_${restored.id}`, STORES.files) as { id: string; blob?: Blob }[];
  expect(files.map((f) => [f.id, !!f.blob])).toEqual([["link1-in-s0", true], ["link1-in-s1", true], ["link1-in-s2", false], ["link1-in-s3", true]]);
});

it("another profile's files travel in its backup too, read from its own database", async () => {
  const work = createProfile("Work");
  const dbName = `ghostly_${work.id}`;
  const big = pattern(SMALL_FILE_BYTES + 5, 9);
  const request = indexedDB.open(dbName, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("settings");
    db.createObjectStore("links", { keyPath: "id" });
    db.createObjectStore("files", { keyPath: "id" }).put({ id: "w-in-a", linkId: "w", blob: new Blob([pattern(500, 1)], { type: "audio/ogg" }), createdAt: 1 });
    db.createObjectStore("fileState", { keyPath: "id" }).put({ id: "w-in-b", bytes: "idb" });
    request.transaction!.objectStore("files").put({ id: "w-in-b", linkId: "w", createdAt: 2, metadata: { name: "b.mp4", size: big.length, mime: "video/mp4", timestamp: 2 } });
    const chunks = db.createObjectStore("fileChunks", { keyPath: ["id", "index"] });
    for (let index = 0; index * MIB < big.length; index++) { const part = big.subarray(index * MIB, (index + 1) * MIB); chunks.put({ id: "w-in-b", index, length: part.length, data: new Blob([part]) }); }
  };
  (await wrap(request)).close();
  await openDb();

  const copy = await restoreProfileBackup(await createProfileBackup(PASS, work.id), PASS);
  const files = await readAll(`ghostly_${copy.id}`, STORES.files) as { id: string; blob?: Blob; bytes?: string }[];
  expect(files.map((f) => f.id)).toEqual(["w-in-a", "w-in-b"]);
  expect(same(new Uint8Array(await files[0].blob!.arrayBuffer()), pattern(500, 1))).toBe(true);
  expect(files[1].bytes).toBe("idb");
  expect(same(await pieces(`ghostly_${copy.id}`, "w-in-b"), big)).toBe(true);
});
