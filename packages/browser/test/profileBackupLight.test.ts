import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memorySink } from "../src/backup/stream";
import { LIGHT_FILE_BYTES, LIGHT_VOICE_BYTES, keptInLight } from "../src/backup/light";
import { STORES, openDb, setDatabaseName, transact, wrap, type StoredFile } from "../src/shared/idb";
import { fileBytes, resetFileBytes } from "../src/shared/fileBytes";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { listProfiles } from "../../../apps/ui/src/lib/profiles";
import { openProfileBackup, profileBackupSizes, restoreOpenedBackup, writeProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.light

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
beforeEach(async () => {
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setStorageProfile("");
  setDatabaseName("ghostly");
  resetFileBytes();
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "a long backup passphrase";
const MIB = 1024 * 1024;
const pattern = (length: number, seed: number) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };
async function readAll(dbName: string, store: string) {
  const db = await wrap(indexedDB.open(dbName));
  try { return await wrap(db.transaction(store, "readonly").objectStore(store).getAll()); } finally { db.close(); }
}
const VOICE = { duration: 600_000, peaks: [1, 2, 3] };

/**
 * A profile with a chat, ten messages, a wallet's ecash and four files: a small picture (a Blob), a 3 MiB voice note
 * (a Blob), a 2 MiB picture (a Blob) and a 5 MiB video in file storage.
 */
async function seed() {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ defaultNickname: "Nick" }));
  await openDb();
  const blob = (size: number, seed: number, type: string) => new Blob([pattern(size, seed)], { type });
  await transact([STORES.links, STORES.messages, STORES.files, STORES.fileState, STORES.settings, STORES.proofs], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    for (let i = 0; i < 10; i++) s[STORES.messages].put({ linkId: "link1", id: `m${i}`, text: `message ${i}` });
    s[STORES.settings].put({ nick: "Nick" }, "settings");
    s[STORES.proofs].put({ secret: "s1", amount: 64, id: "keyset", C: "c", mintUrl: "https://mint.test" });
    s[STORES.files].put({ id: "link1-in-small", linkId: "link1", blob: blob(1000, 1, "image/png"), createdAt: 1, metadata: { name: "small.png", size: 1000, mime: "image/png", timestamp: 1 } });
    s[STORES.files].put({ id: "link1-in-voice", linkId: "link1", blob: blob(3 * MIB, 2, "audio/webm"), createdAt: 2, metadata: { name: "voice.webm", size: 3 * MIB, mime: "audio/webm", timestamp: 2, voice: VOICE } });
    s[STORES.files].put({ id: "link1-out-photo", linkId: "link1", blob: blob(2 * MIB, 3, "image/jpeg"), createdAt: 3, direction: "out", metadata: { name: "photo.jpg", size: 2 * MIB, mime: "image/jpeg", timestamp: 3 } });
  });
  const store = await fileBytes();
  const id = "link1-in-video", size = 5 * MIB, bytes = pattern(size, 4);
  for (let at = 0; at < size; at += MIB) await store.append(id, at, bytes.subarray(at, at + MIB));
  await store.close(id);
  await transact([STORES.files, STORES.fileState], (s) => {
    s[STORES.files].put({ id, linkId: "link1", createdAt: 4, direction: "in", metadata: { name: "video.mp4", size, mime: "video/mp4", timestamp: 4 } });
    s[STORES.fileState].put({ id, bytes: store.kind, digest: "d", transfer: { state: "done", transferred: size, size } });
  });
}

async function backUp(light: boolean) {
  const sink = memorySink();
  const result = await writeProfileBackup(sink, { passphrase: PASS, light });
  return { bundle: sink.bytes(), result };
}

it("keeps voice notes up to 4 MiB and other files up to 1 MiB", () => {
  expect(keptInLight(LIGHT_FILE_BYTES, false)).toBe(true);
  expect(keptInLight(LIGHT_FILE_BYTES + 1, false)).toBe(false);
  expect(keptInLight(LIGHT_VOICE_BYTES, true)).toBe(true);
  expect(keptInLight(LIGHT_VOICE_BYTES + 1, true)).toBe(false);
});

it("the sizes before a backup: every file's bytes, and what a light one keeps", async () => {
  await seed();
  expect(await profileBackupSizes()).toEqual({ everything: 1000 + 10 * MIB, light: 1000 + 3 * MIB, leftOut: 2, leftOutBytes: 7 * MIB });
});

it("a light backup leaves the larger files' bytes out, says so, and restores every message with them marked", async () => {
  await seed();
  const everything = await backUp(false);
  const light = await backUp(true);
  expect(light.result).toMatchObject({ files: 2, fileBytes: 1000 + 3 * MIB, skipped: 0, leftOut: 2, leftOutBytes: 7 * MIB });
  expect(everything.result).toEqual({ bytes: everything.bundle.length, files: 4, fileBytes: 1000 + 10 * MIB, skipped: 0 });
  expect(light.bundle.length).toBeLessThan(everything.bundle.length / 2);

  const opened = await openProfileBackup(light.bundle, PASS);
  expect(opened.light).toEqual({ maxFileBytes: LIGHT_FILE_BYTES, maxVoiceBytes: LIGHT_VOICE_BYTES, files: 2, bytes: 7 * MIB });
  expect((await openProfileBackup(everything.bundle, PASS)).light).toBeUndefined();

  const entry = await restoreOpenedBackup(opened);
  expect(listProfiles().some((profile) => profile.id === entry.id)).toBe(true);
  const space = `ghostly_${entry.id}`;
  expect((await readAll(space, STORES.messages)).map((m) => (m as { text: string }).text).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `message ${i}`));
  expect(await readAll(space, STORES.proofs)).toHaveLength(1);
  const files = new Map((await readAll(space, STORES.files) as StoredFile[]).map((file) => [file.id, file]));
  expect(files.size).toBe(4);
  // Kept: the small picture and the voice note, with their bytes.
  expect(files.get("link1-in-small")?.blob?.size).toBe(1000);
  expect(files.get("link1-in-voice")?.blob?.size).toBe(3 * MIB);
  expect(files.get("link1-in-voice")?.leftOut).toBeUndefined();
  // Left out: the record and its finished transfer, no bytes nor where they were, and the mark.
  for (const id of ["link1-out-photo", "link1-in-video"]) {
    const file = files.get(id)!;
    expect(file).toMatchObject({ leftOut: true, linkId: "link1" });
    expect(file.blob).toBeUndefined();
    expect(file.bytes).toBeUndefined();
  }
  expect(files.get("link1-in-video")?.transfer).toEqual({ state: "done", transferred: 5 * MIB, size: 5 * MIB });
  // What changed about the left-out video went with its record: no row of its own that would say where bytes are.
  expect(await readAll(space, STORES.fileState)).toEqual([]);
});

it("an everything backup of a restored light profile keeps the marks", async () => {
  await seed();
  const restored = await restoreOpenedBackup(await openProfileBackup((await backUp(true)).bundle, PASS));
  setStorageProfile(restored.id);
  setDatabaseName(`ghostly_${restored.id}`);
  const again = await backUp(false);
  expect(again.result).toMatchObject({ files: 2, skipped: 0 });
  const twice = await restoreOpenedBackup(await openProfileBackup(again.bundle, PASS));
  const files = await readAll(`ghostly_${twice.id}`, STORES.files) as StoredFile[];
  expect(files.filter((file) => file.leftOut).map((file) => file.id).sort()).toEqual(["link1-in-video", "link1-out-photo"]);
});
