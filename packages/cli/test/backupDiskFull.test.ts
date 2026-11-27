// covers: headless.backup
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS } from "../src/backup";
import { home } from "./support/cli";

afterEach(() => { vi.restoreAllMocks(); });

const full = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });

type Write = (this: FileHandle, buffer: Uint8Array, offset?: number, length?: number) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

/*
 * Frames are held and written together, the last of them after `finish()`. A disk that fills on that last write, or
 * takes only part of it (a write that returns fewer bytes than it was given, the next one failing), fails the backup as
 * a disk full: never a backup reported as made that does not restore.
 */
it.each([
  ["fails on the last write", false],
  ["takes only part of the last write, then fails", true],
] as const)("a backup whose disk %s fails as `unavailable` and leaves neither --out nor its half-written file", async (_, short) => {
  const dir = home(`backup-disk-full-${short ? "short" : "fail"}`);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(paths.files, `file-${i}`), `file ${i} `.repeat(50));
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const outDir = join(dir, "out");
  mkdirSync(outDir);
  const probe = await open(join(dir, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { write: Write };
  await probe.close();
  const write = proto.write;
  // This profile's backup (~10 KB) is one held chunk: its only write is the last one.
  let writes = 0;
  vi.spyOn(proto, "write").mockImplementation(async function (this: FileHandle, buffer, offset, length) {
    if (!(buffer instanceof Uint8Array) || buffer.length < 1000) return write.call(this, buffer, offset, length);
    if (writes++ || !short) throw full();
    const { bytesWritten } = await write.call(this, buffer, offset ?? 0, (length ?? buffer.length) - 500);
    return { bytesWritten, buffer };
  } as Write);
  await expect(BACKUP_METHODS["profile.backup"](ctx, { path: join(outDir, "b.ghostly-backup"), noPassphrase: true })).rejects.toMatchObject({ code: "unavailable" });
  expect(writes).toBe(short ? 2 : 1);
  expect(readdirSync(outDir)).toEqual([]);
  expect(readdirSync(paths.db)).toEqual([]);
});

it("a backup whose write takes nothing of what it is given fails as a disk full, naming --out, and leaves no file", async () => {
  const dir = home("backup-disk-full-none");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(paths.files, `file-${i}`), `file ${i} `.repeat(50));
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const outDir = join(dir, "out");
  mkdirSync(outDir);
  const probe = await open(join(dir, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { write: Write };
  await probe.close();
  const write = proto.write;
  // The disk says it is full only by taking no byte of the backup's one held chunk.
  vi.spyOn(proto, "write").mockImplementation(async function (this: FileHandle, buffer, offset, length) {
    if (!(buffer instanceof Uint8Array) || buffer.length < 1000) return write.call(this, buffer, offset, length);
    return { bytesWritten: 0, buffer };
  } as Write);
  const out = join(outDir, "b.ghostly-backup");
  await expect(BACKUP_METHODS["profile.backup"](ctx, { path: out, noPassphrase: true })).rejects.toMatchObject({
    code: "unavailable",
    message: `No room left for ${out}: free some space, then try again`,
    details: { reason: "no_space", errno: "ENOSPC", path: out },
  });
  expect(readdirSync(outDir)).toEqual([]);
});
