import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupWriter, memorySink } from "@ghostly/browser/backup/stream";
import { restoreProfile } from "../src/backup";
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

/** A backup as `profile backup` writes it, with `extra` records before its end. */
async function backup(dir: string, extra: object[]): Promise<string> {
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, PASS);
  const put = (record: object) => writer.json(JSON.stringify(record));
  await put({ t: "profile", format: "ghostly-cli-profile/2", createdAt: Date.now(), files: 0, bytes: 0 });
  await put({ t: "file", kind: "store", size: 5 });
  await writer.bytes(new TextEncoder().encode("STORE"));
  for (const record of extra) await put(record);
  await put({ t: "end", files: 0, bytes: 0 });
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
