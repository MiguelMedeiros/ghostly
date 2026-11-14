import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS } from "../src/backup";
import { home } from "./support/cli";

// The store's export is written a page at a time: one that fails part way (its disk full) has written a part of every
// message in the profile beside rows.db. The backup failed, and that copy stayed there: the next one's did too.
it("a backup whose store export fails part way leaves no copy of the store in the profile", async () => {
  const dir = home("backup-store-failed");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  writeFileSync(join(paths.db, "rows.db"), "ROWS");
  const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const store = { async exportSnapshot(path: string) { await writeFile(path, "A PART OF THE STORE", { mode: 0o600 }); throw full; } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  await expect(BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, "full.ghostly-backup"), noPassphrase: true })).rejects.toThrow();
  expect(readdirSync(paths.db)).toEqual(["rows.db"]);
  expect(readdirSync(dir).filter((name) => name.includes("ghostly-backup"))).toEqual([]);
});
