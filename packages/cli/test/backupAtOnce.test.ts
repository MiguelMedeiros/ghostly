import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS } from "../src/backup";
import { home } from "./support/cli";

// Two `profile backup` at once in one daemon (a cron job's and one typed by hand, a bot's two calls on the socket): each
// writes the store for its backup into the profile's db folder. That file was named by the process only, so the two
// shared it: the first to finish removed it under the other, which failed (or packed the other's store as its own).
it("two backups at once through one daemon each carry their own store, and leave none behind", async () => {
  const dir = home("backup-at-once");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  let calls = 0;
  const store = {
    // The second export is slow to finish (a store of 100,000 messages, read a page at a time): the first backup ends
    // meanwhile.
    async exportSnapshot(path: string) {
      const n = ++calls;
      await writeFile(path, `STORE-${n}-`.repeat(200), { mode: 0o600 });
      if (n === 2) await new Promise((resolve) => setTimeout(resolve, 300));
    },
  };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const backup = (out: string) => BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true });

  const [first, second] = await Promise.allSettled([backup("one.ghostly-backup"), backup("two.ghostly-backup")]);
  expect(first.status).toBe("fulfilled");
  expect(second.status).toBe("fulfilled");
  // Not sealed: each file shows the store it was given, and only that one.
  const one = readFileSync(join(dir, "one.ghostly-backup"), "latin1"), two = readFileSync(join(dir, "two.ghostly-backup"), "latin1");
  expect(one).toContain("STORE-1-");
  expect(one).not.toContain("STORE-2-");
  expect(two).toContain("STORE-2-");
  expect(two).not.toContain("STORE-1-");
  expect(readdirSync(paths.db), "each removes its own store file when done").toEqual([]);
});
