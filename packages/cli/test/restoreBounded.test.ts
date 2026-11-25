import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seal } from "@ghostly/browser/backup/envelope";
import { BackupWriter, memorySink } from "@ghostly/browser/backup/stream";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { profilePaths } from "../src/profiles";
// covers: headless.backup

/*
 * A sealed backup is restored only with its passphrase, but whoever made it chose every record in it. Its JSON is
 * compressed: a few kilobytes of it can unpack to hundreds of megabytes. A restore takes no more of a record than this
 * CLI's backups hold, and leaves no profile when it refuses one.
 */

/** PBKDF2 at the real 600,000 rounds is slow on a loaded machine: run fewer. */
beforeEach(() => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "correct horse battery";
const MIB = 1024 * 1024;

/** A backup as `profile backup` writes it, with `extra` records (objects, or JSON as written) before its end. */
async function backup(dir: string, extra: (object | string)[], end = { files: 0, bytes: 0 }): Promise<string> {
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, PASS);
  const put = (record: object | string) => writer.json(typeof record === "string" ? record : JSON.stringify(record));
  await put({ t: "profile", format: "ghostly-cli-profile/2", createdAt: Date.now(), files: 0, bytes: 0 });
  await put({ t: "file", kind: "store", size: 5 });
  await writer.bytes(new TextEncoder().encode("STORE"));
  for (const record of extra) await put(record);
  await put({ t: "end", ...end });
  await writer.finish();
  const file = join(dir, "made.ghostly-backup");
  writeFileSync(file, sink.bytes());
  return file;
}

const nothingLeft = (dir: string, name: string) => {
  expect(existsSync(profilePaths(dir, name).dir)).toBe(false);
  expect(readdirSync(join(dir, "profiles")).filter((entry) => entry.startsWith(".restoring-"))).toEqual([]);
};

it("restores a backup with its settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const groups = JSON.stringify({ grants: [{ chat: "c1", contact: "k1" }] });
  const file = await backup(dir, [{ t: "setting", name: "groups.json", text: groups }, { t: "later", note: "a newer CLI's record" }]);
  const paths = await restoreProfile(dir, "back", file, PASS);
  expect(readFileSync(join(paths.dir, "groups.json"), "utf8")).toBe(groups);
  expect(readFileSync(join(paths.db, "snapshot.bin"), "utf8")).toBe("STORE");
});

it("refuses a setting larger than any a profile writes, and leaves no profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const file = await backup(dir, [{ t: "setting", name: "groups.json", text: "a".repeat(MIB + 1) }]);
  expect(readFileSync(file).length).toBeLessThan(64 * 1024);
  await expect(restoreProfile(dir, "back", file, PASS)).rejects.toMatchObject({ code: "refused", message: "This backup is too large to restore" });
  nothingLeft(dir, "back");
});

it("refuses a large record it does not know instead of unpacking and skipping it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const file = await backup(dir, [{ t: "later", pad: "a".repeat(100 * 1024) }]);
  await expect(restoreProfile(dir, "back", file, PASS)).rejects.toMatchObject({ code: "refused", message: "This backup is too large to restore" });
  nothingLeft(dir, "back");
});

it("stops unpacking a record past what any of its records holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const file = await backup(dir, [{ t: "later", pad: "a".repeat(40 * MIB) }]);
  expect(readFileSync(file).length).toBeLessThan(MIB);
  await expect(restoreProfile(dir, "back", file, PASS)).rejects.toMatchObject({ code: "refused", message: "This backup is too large to restore" });
  nothingLeft(dir, "back");
});

it("refuses a record of brackets that would cost seconds to parse, before parsing it", async () => {
  // JSON of nested brackets costs a hundred times more to parse than its size, and packs about 1000:1: each record here
  // is ~16 MiB from ~16 KB of the file. A record of a file is a few fields.
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const depth = 8 * MIB - 64, pad = "[".repeat(depth) + "]".repeat(depth);
  const records = [0, 1, 2].map((i) => `{"t":"file","kind":"file","path":"f-${i}","size":0,"pad":${pad}}`);
  const file = await backup(dir, records, { files: 3, bytes: 0 });
  expect(readFileSync(file).length).toBeLessThan(MIB);
  const started = Date.now();
  await expect(restoreProfile(dir, "back", file, PASS)).rejects.toMatchObject({ code: "refused", message: "This backup is too large to restore" });
  expect(Date.now() - started).toBeLessThan(20_000);
  nothingLeft(dir, "back");
}, 120_000);

it("refuses a version 1 backup that unpacks to far more than its size, and leaves no profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  mkdirSync(join(dir, "profiles"));
  const file = join(dir, "made.ghostly-backup");
  writeFileSync(file, await seal(JSON.stringify({ format: "ghostly-cli-profile/1", createdAt: 1, store: "A".repeat(100 * MIB), files: [] }), PASS));
  expect(readFileSync(file).length).toBeLessThan(MIB);
  await expect(restoreProfile(dir, "back", file, PASS)).rejects.toMatchObject({ code: "refused", message: "This backup is too large to restore" });
  nothingLeft(dir, "back");
}, 120_000);

it("`profile backup` refuses a setting no restore takes, before writing anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-bounded-"));
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.files, { recursive: true });
  mkdirSync(paths.db, { recursive: true });
  writeFileSync(join(dir, "groups.json"), JSON.stringify({ grants: Array.from({ length: 20_000 }, (_, i) => ({ chat: `chat-${i}`, contact: "k".repeat(52) })) }));
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const out = join(dir, "out.ghostly-backup");
  await expect(BACKUP_METHODS["profile.backup"](ctx, { path: out, noPassphrase: true })).rejects.toMatchObject({ code: "refused", message: "groups.json of this profile is too large for a backup (over 1 MiB)" });
  expect(readdirSync(dir).filter((entry) => entry.startsWith("out."))).toEqual([]);
  // One under the cap is backed up and restored.
  writeFileSync(join(dir, "groups.json"), JSON.stringify({ grants: Array.from({ length: 5_000 }, (_, i) => ({ chat: `chat-${i}`, contact: "k".repeat(52) })) }));
  await BACKUP_METHODS["profile.backup"](ctx, { path: out, noPassphrase: true });
  const restored = await restoreProfile(dir, "back", out);
  expect(readFileSync(join(restored.dir, "groups.json"), "utf8")).toBe(readFileSync(join(dir, "groups.json"), "utf8"));
});
