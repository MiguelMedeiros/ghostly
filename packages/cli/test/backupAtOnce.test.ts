import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, backupFileProtection } from "../src/backup";
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
  // Not sealed: each file shows the store it was given, and only that one. Which backup exports first is the file
  // system's (each reads its folder and settings before), so the two stores are told apart, not their order.
  const holds = (file: string) => {
    const text = readFileSync(join(dir, file), "latin1");
    return ["STORE-1-", "STORE-2-"].filter((store) => text.includes(store));
  };
  const [one, two] = [holds("one.ghostly-backup"), holds("two.ghostly-backup")];
  expect(one).toHaveLength(1);
  expect(two).toHaveLength(1);
  expect(one).not.toEqual(two);
  expect(readdirSync(paths.db), "each removes its own store file when done").toEqual([]);
});

// Two at once to one --out: each wrote it through `<out>.partial-<pid>`, the same name in one daemon. The second took the
// first's half-written file for one an earlier backup left and removed it, so the first gave its name to the second's
// file and said it wrote a backup it had not (or failed with ENOENT when the second stopped first).
it("two backups at once to one --out: the one that writes it gets its own backup there", async () => {
  const dir = home("backup-same-out");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  // Many frames to copy, so the second opens its file while the first still writes.
  await writeFile(join(paths.files, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  let calls = 0;
  const store = {
    async exportSnapshot(path: string) {
      const n = ++calls;
      await writeFile(path, `STORE-${n}-`.repeat(200), { mode: 0o600 });
      if (n === 2) await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const out = join(dir, "same.ghostly-backup");
  const results = await Promise.allSettled([
    BACKUP_METHODS["profile.backup"](ctx, { path: out, noPassphrase: true }),
    BACKUP_METHODS["profile.backup"](ctx, { path: out, passphrase: "correct horse battery staple" }),
  ]);
  const written = results.filter((result) => result.status === "fulfilled").map((result) => result.value as { protection: string });
  expect(written).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "refused" } });
  // The file at --out is the backup its answer describes.
  expect(await backupFileProtection(out)).toBe(written[0].protection);
  expect(readdirSync(dir).filter((name) => name.includes(".partial")), "no half-written file left").toEqual([]);
});
