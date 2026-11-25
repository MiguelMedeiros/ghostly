// covers: headless.backup
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

// A file system with no hard links (FAT/exFAT answer EPERM, some network shares ENOTSUP): the backup's name is given
// by link() everywhere else.
const noLinks = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, link: async (...args: Parameters<typeof fs.link>) => {
    if (noLinks.code) throw Object.assign(new Error(`${noLinks.code}: operation not permitted, link '${String(args[0])}' -> '${String(args[1])}'`), { code: noLinks.code, path: String(args[0]), dest: String(args[1]) });
    return fs.link(...args);
  } };
});

/** A profile with one file; `exported` runs once the backup took the store, after it checked --out's name. */
function profile(name: string, exported = () => {}) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  writeFileSync(join(paths.files, "kept"), "KEPT");
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); exported(); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const backup = async (out: string) => {
    try { return await BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true }); } finally { noLinks.code = undefined; }
  };
  // What is beside the profile's own folders: the backup alone, its half-written file gone.
  return { dir, backup, beside: () => readdirSync(dir).filter((entry) => !["db", "files"].includes(entry)) };
}

// Before, "Not allowed to write or read <--out>" and no backup on a USB stick, the obvious way to move a profile.
it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])("a folder whose file system has no hard links (%s) gets the backup, which restores", async (code) => {
  const { dir, backup, beside } = profile(`backup-no-links-${code}`);
  noLinks.code = code;
  expect(await backup("usb.ghostly-backup")).toMatchObject({ files: 1 });
  expect(beside()).toEqual(["usb.ghostly-backup"]);
  expect(statSync(join(dir, "usb.ghostly-backup")).mode & 0o777).toBe(0o600);
  const restored = await restoreProfile(home(`backup-no-links-${code}-to`), "back", join(dir, "usb.ghostly-backup"));
  expect(readdirSync(restored.files)).toEqual(["kept"]);
});

it("with no hard links, a file that took --out's name meanwhile is still never written over", async () => {
  const name = "taken.ghostly-backup";
  const { dir, backup, beside } = profile("backup-no-links-taken", () => writeFileSync(join(dir, name), "THEIRS"));
  noLinks.code = "EPERM";
  await expect(backup(name)).rejects.toMatchObject({ code: "refused", message: `${join(dir, name)} exists: choose another name` });
  expect(beside()).toEqual([name]);
  expect(statSync(join(dir, name)).size).toBe("THEIRS".length);
});

// Any other error of link() is still the backup's own: a folder it may not write is named as --out's.
it("a link() refused for another reason still fails the backup, and leaves no file", async () => {
  const { dir, backup, beside } = profile("backup-no-links-other");
  noLinks.code = "EACCES";
  await expect(backup("other.ghostly-backup")).rejects.toMatchObject({ code: "EACCES", path: join(dir, "other.ghostly-backup") });
  expect(beside()).toEqual([]);
});
