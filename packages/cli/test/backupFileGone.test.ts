import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

// What the backup opens: a test removes a file of the profile right before (the daemon's own removal, mid-backup).
const beforeOpen = vi.hoisted(() => ({ hook: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (path: string, ...rest: unknown[]) => { await beforeOpen.hook?.(String(path)); return (fs.open as (...args: unknown[]) => unknown)(path, ...rest); } };
});

function profile(name: string) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  return { dir, paths, backup: (out: string) => BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true }) };
}

// The daemon removes files while a backup runs (a deleted or disappearing message's, a group's files): the walk of
// the files folder and the copy of each took seconds on a large profile, and one gone meanwhile failed the backup with
// Node's bare ENOENT.
it("a file removed while the files folder is read is left out, and the backup is made", async () => {
  const { dir, paths, backup } = profile("backup-gone-walk");
  writeFileSync(join(paths.files, "kept"), "KEPT");
  // Named by the folder, gone at its stat: as a file removed between the two.
  symlinkSync(join(dir, "removed"), join(paths.files, "gone"));
  const result = await backup("walk.ghostly-backup");
  expect(result).toMatchObject({ files: 1 });
  expect(readdirSync(paths.db)).toEqual([]);
  const restored = await restoreProfile(home("backup-gone-walk-to"), "back", join(dir, "walk.ghostly-backup"));
  expect(readdirSync(restored.files)).toEqual(["kept"]);
});

it("a file removed after the walk, before its copy, is left out, and the backup restores", async () => {
  const { dir, paths, backup } = profile("backup-gone-copy");
  writeFileSync(join(paths.files, "a"), "AAAA");
  writeFileSync(join(paths.files, "b"), "BBBBBBBB");
  // The first file copied removes the other, whichever comes first.
  beforeOpen.hook = async (path) => {
    if (!path.startsWith(paths.files)) return;
    beforeOpen.hook = undefined;
    await rm(join(paths.files, path.endsWith("/a") ? "b" : "a"));
  };
  try {
    const result = await backup("copy.ghostly-backup");
    expect(result).toMatchObject({ files: 1 });
  } finally { beforeOpen.hook = undefined; }
  const left = readdirSync(paths.files);
  expect(left).toHaveLength(1);
  const restored = await restoreProfile(home("backup-gone-copy-to"), "back", join(dir, "copy.ghostly-backup"));
  expect(readdirSync(restored.files)).toEqual(left);
});
