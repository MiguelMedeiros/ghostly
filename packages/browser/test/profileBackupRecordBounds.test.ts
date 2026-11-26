import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupWriter, memorySink } from "../src/backup/stream";
import { seal } from "../src/backup/envelope";
import { STORES, openDb, transact } from "../src/shared/idb";
import { resetFileBytes } from "../src/shared/fileBytes";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { listProfiles } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, openProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.stream

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
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  storage = new FakeStorage();
  setStorageProfile("");
  resetFileBytes();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});
afterEach(() => { vi.restoreAllMocks(); });

const MIB = 1024 * 1024;
const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();
const HEAD = JSON.stringify({ t: "profile", format: "ghostly-profile", version: 2, createdAt: 1, profile: { name: "Made", builtIn: false }, storage: {}, files: 0, bytes: 0 });
/** A bundle anyone can read: a profile's head, then `records` as they are. */
async function bundleOf(...records: string[]): Promise<Uint8Array> {
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, null);
  await writer.json(HEAD);
  for (const record of records) await writer.json(record);
  await writer.finish();
  return sink.bytes();
}
const rowsOf = (store: string, values: string) => `{"t":"rows","db":"peer","store":"${store}","keys":[],"values":[${values}]}`;
/** What it gives, not the megabytes a failure would print. */
const outcome = (run: Promise<unknown>) => run.then(() => "opened", (error: Error) => error.message);
/** The largest JSON text parsed: one far over what a profile writes is not parsed but noted, so a test that fails does so fast. */
function watchParse() {
  const parse = JSON.parse.bind(JSON);
  const seen = { largest: 0 };
  vi.spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    seen.largest = Math.max(seen.largest, text.length);
    if (text.length > 16 * MIB) throw new Error("parsed whole");
    return parse(text, reviver);
  }) as typeof JSON.parse);
  return seen;
}
async function expectRefused(bundle: Uint8Array) {
  const before = await databases();
  expect(await outcome(openProfileBackup(bundle))).toBe("This backup is too large to restore");
  expect(await outcome(restoreProfileBackup(bundle))).toBe("This backup is too large to restore");
  expect(await databases()).toEqual(before);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
}

it("a small bundle holding one record of 255 MiB is refused without that record being unpacked whole", async () => {
  // Then a few MB that gzip does not shrink: a bundle that size may unpack to over 255 MiB in all, but no record to that.
  const random = new Uint8Array(4 * MIB);
  for (let at = 0; at < random.length; at += 65_536) crypto.getRandomValues(random.subarray(at, at + 65_536));
  const bundle = await bundleOf(rowsOf("settings", `"${"A".repeat(255 * MIB - 100)}"`), JSON.stringify({ t: "later", pad: Buffer.from(random).toString("base64") }));
  expect(bundle.length).toBeGreaterThan(3.5 * MIB);
  expect(bundle.length).toBeLessThan(8 * MIB);
  const decode = TextDecoder.prototype.decode;
  let largest = 0;
  vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
    largest = Math.max(largest, input?.byteLength ?? 0);
    return decode.call(this, input, options);
  });
  await expectRefused(bundle);
  expect(largest).toBeLessThanOrEqual(64 * MIB);
}, 120_000);

it("a bundle of some 70 KB whose record is tens of MB of empty brackets is refused before it is parsed", async () => {
  // 63 MiB of `[],`: some 22 million arrays, over a gigabyte of a tab's heap once parsed.
  const bundle = await bundleOf(rowsOf("links", "[],".repeat(Math.floor(63 * MIB / 3)) + "[]"));
  expect(bundle.length).toBeLessThan(100 * 1024);
  const seen = watchParse();
  await expectRefused(bundle);
  expect(seen.largest).toBeLessThan(MIB);
}, 120_000);

// A value costs the parse (and its reviver) far more than its byte or two: `0,` or `"",` weigh as much as `[],`.
for (const [shape, value] of [["zeros", "0,"], ["empty strings", `"",`]] as const) {
  it(`a bundle of some 70 KB whose record is tens of MB of ${shape} is refused before it is parsed`, async () => {
    const bundle = await bundleOf(rowsOf("settings", value.repeat(Math.floor(63 * MIB / value.length)) + "0"));
    expect(bundle.length).toBeLessThan(100 * 1024);
    const seen = watchParse();
    await expectRefused(bundle);
    expect(seen.largest).toBeLessThan(MIB);
  }, 120_000);
}

it("a version 1 backup that unpacks to tens of MB of zeros is refused before it is parsed", async () => {
  const head = `{"format":"ghostly-profile","version":1,"profile":{"name":"Made","builtIn":false},"storage":{},"databases":{"peer":null,"ark":{}}`;
  const bundle = await seal(`${head},"pad":[${"0,".repeat(Math.floor(40 * MIB / 2))}0]}`, "a passphrase of the attacker");
  expect(bundle.length).toBeLessThan(100 * 1024);
  const seen = watchParse();
  const before = await databases();
  expect(await outcome(openProfileBackup(bundle, "a passphrase of the attacker"))).toBe("This backup is too large to restore");
  expect(await outcome(restoreProfileBackup(bundle, "a passphrase of the attacker"))).toBe("This backup is too large to restore");
  expect(await databases()).toEqual(before);
  expect(seen.largest).toBeLessThan(MIB);
}, 120_000);

it("a record nested deeper than any a profile writes is refused as too large, not with the parse's stack error", async () => {
  // 990 000 `[`: under the values a record may hold, but `decode`'s reviver recurses once per level.
  const deep = "[".repeat(990_000) + "]".repeat(990_000);
  await expectRefused(await bundleOf(rowsOf("settings", deep)));
  const v1 = `{"format":"ghostly-profile","version":1,"profile":{"name":"Made","builtIn":false},"storage":{},"databases":{"peer":null,"ark":{}},"pad":${deep}}`;
  const sealed = await seal(v1, "a passphrase of the attacker");
  expect(await outcome(openProfileBackup(sealed, "a passphrase of the attacker"))).toBe("This backup is too large to restore");
  // As deep as a contact's odd data may go still restores.
  expect(await outcome(restoreProfileBackup(await bundleOf(`{"t":"later","pad":${"[".repeat(900)}${"]".repeat(900)}}`, `{"t":"end","files":0,"bytes":0}`)))).toBe("opened");
}, 120_000);

it("a bundle of some KB whose head and records hold a bigint of tens of millions of digits opens and restores without reading it", async () => {
  // `BigInt()` of 16 million digits holds a tab's thread for seconds each time it is read; no stored amount or counter has a hundred.
  const digits = { $ghostly: "bigint", value: "9".repeat(16 * MIB) };
  const head = JSON.stringify({ ...JSON.parse(HEAD), createdAt: digits });
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, null);
  await writer.json(head);
  await writer.json(JSON.stringify({ t: "later", n: digits }));
  await writer.json(JSON.stringify({ t: "end", files: 0, bytes: 0 }));
  await writer.finish();
  const bundle = sink.bytes();
  expect(bundle.length).toBeLessThan(100 * 1024);
  const big = vi.spyOn(globalThis, "BigInt");
  expect(await outcome(openProfileBackup(bundle))).toBe("opened");
  expect(await outcome(restoreProfileBackup(bundle))).toBe("opened");
  expect(big.mock.calls.map(([value]) => String(value).length).filter((length) => length > 100)).toEqual([]);
}, 120_000);

it("records each small enough alone are refused once their values add up to far more than the bundle's size", async () => {
  const values = "0,".repeat(600_000) + "0";
  // Rows an open reads on to tell whose profile it is, and records of a kind a newer version adds, which a restore reads past.
  const rows = rowsOf("settings", values), later = `{"t":"later","pad":[${values}]}`;
  const opened = await bundleOf(rows, rows, rows), restored = await bundleOf(later, later, later);
  expect(Math.max(opened.length, restored.length)).toBeLessThan(100 * 1024);
  await expectRefused(opened);
  const before = await databases();
  expect(await outcome(restoreProfileBackup(restored))).toBe("This backup is too large to restore");
  expect(await databases()).toEqual(before);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
}, 120_000);

it("a batch of rows larger than one record goes as smaller ones, and restores whole", async () => {
  storage.setItem("ghostly_app_settings", "{}");
  await openDb();
  // 400 messages of 200 KB each: a batch of 80 MB, over what one record holds. Text that gzip does not shrink a
  // thousand times, as no real chat's does: a bundle that unpacks to that much more than its size is refused.
  const random = new Uint8Array(150 * 1024);
  for (let at = 0; at < random.length; at += 65_536) crypto.getRandomValues(random.subarray(at, at + 65_536));
  const text = btoa(Array.from(random, (byte) => String.fromCharCode(byte)).join(""));
  await transact([STORES.links, STORES.messages], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    for (let i = 0; i < 400; i++) s[STORES.messages].put({ linkId: "link1", id: `m${String(i).padStart(3, "0")}`, text: `${i}${text}` });
  });
  const bundle = await createProfileBackup(null);
  const restored = await restoreProfileBackup(bundle);
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`ghostly_${restored.id}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    const rows = await new Promise<{ id: string; text: string }[]>((resolve, reject) => { const r = db.transaction(STORES.messages, "readonly").objectStore(STORES.messages).getAll(); r.onsuccess = () => resolve(r.result as { id: string; text: string }[]); r.onerror = () => reject(r.error); });
    expect(rows.length).toBe(400);
    expect(rows[399].text).toBe(`399${text}`);
  } finally { db.close(); }
}, 120_000);
