import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS } from "../src/backup";
import { home } from "./support/cli";

// Every path the backup stats, and the most stats it had going at once.
const stats = vi.hoisted(() => ({ paths: [] as string[], running: 0, most: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      stats.paths.push(String(args[0]));
      stats.most = Math.max(stats.most, ++stats.running);
      try { return await fs.stat(...args); } finally { stats.running--; }
    },
  };
});

// The walk of the files folder stats each file, and the backup then stated every one again, all at once, for its size:
// a profile with 20,000 files held the daemon's thread ~100 ms on the second pass alone.
it("a backup stats each file of the profile once, one at a time", async () => {
  const dir = home("backup-stat-once");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(join(paths.files, "sub"), { recursive: true });
  mkdirSync(paths.db, { recursive: true });
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  for (let i = 0; i < 30; i++) writeFileSync(join(paths.files, `file-${i}`), `file ${i} `.repeat(i + 1));
  writeFileSync(join(paths.files, "sub", "inner"), "INNER");
  stats.paths.length = 0;
  stats.most = 0;
  const result = await BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, "out.ghostly-backup"), noPassphrase: true });
  expect(result).toMatchObject({ files: 31 });
  const ofFiles = stats.paths.filter((path) => path.startsWith(paths.files + "/") && !path.endsWith("/sub"));
  expect(ofFiles).toHaveLength(31);
  expect(new Set(ofFiles).size).toBe(31);
  expect(stats.most).toBe(1);
});
