// covers: headless.backup
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

/*
 * Where the file system has no hard links (a FAT/exFAT stick), the finished backup is copied under --out's name. A
 * write may take only part of what it is given (the stick filling as it writes) and say so only in the bytes it
 * reports: a copy that took one write's word for it named a backup cut short, with no error. It finishes each write,
 * or fails as a full disk does and leaves no file.
 */

const placing = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, link: async (...args: Parameters<typeof fs.link>) => {
    // From here on, every write is the copy's.
    placing.on = true;
    throw Object.assign(new Error(`EPERM: operation not permitted, link '${String(args[0])}' -> '${String(args[1])}'`), { code: "EPERM", path: String(args[0]), dest: String(args[1]) });
  } };
});

afterEach(() => { vi.restoreAllMocks(); placing.on = false; });

type Write = (...args: unknown[]) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

const KEPT = randomBytes(300_000);

/** A profile with one file, backed up without a passphrase to `out` beside it. */
function profile(name: string) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  writeFileSync(join(paths.files, "kept"), KEPT);
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const backup = (out: string) => BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true }) as Promise<{ bytes: number; files: number }>;
  return { dir, backup, beside: () => readdirSync(dir).filter((entry) => !["db", "files"].includes(entry)) };
}

/** Once the copy starts, each write takes at most `room` of the bytes it is asked for. */
async function shortCopy(room: number): Promise<void> {
  const probe = await open(join(home("backup-place-probe"), "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { write: Write };
  await probe.close();
  const real = proto.write;
  vi.spyOn(proto, "write").mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (!placing.on) return real.apply(this, args);
    const buffer = args[0] as Uint8Array, offset = (args[1] as number | undefined) ?? 0;
    const length = (args[2] as number | undefined) ?? buffer.length - offset;
    return real.call(this, buffer, offset, Math.min(length, room), args[3] ?? null);
  });
}

it("finishes a copy the disk took only part of each write of: the backup is whole and restores", async () => {
  const { dir, backup, beside } = profile("backup-place-short");
  await shortCopy(4096);
  const done = await backup("usb.ghostly-backup");
  vi.restoreAllMocks();
  const file = join(dir, "usb.ghostly-backup");
  expect(beside()).toEqual(["usb.ghostly-backup"]);
  expect(statSync(file).size).toBe(done.bytes);
  const restored = await restoreProfile(home("backup-place-short-to"), "back", file);
  expect(readFileSync(join(restored.files, "kept")).equals(KEPT)).toBe(true);
});

it("fails as a full disk does when the copy's write takes nothing, and leaves no file", async () => {
  const { dir, backup, beside } = profile("backup-place-none");
  await shortCopy(0);
  const out = join(dir, "full.ghostly-backup");
  await expect(backup("full.ghostly-backup")).rejects.toMatchObject({
    code: "unavailable",
    message: `No room left for ${out}: free some space, then try again`,
    details: { reason: "no_space", errno: "ENOSPC", path: out },
  });
  vi.restoreAllMocks();
  expect(beside()).toEqual([]);
});
