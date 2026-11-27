import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BackupWriter, memorySink } from "@ghostly/browser/backup/stream";
import { restoreProfile } from "../src/backup";
import { asCliError } from "../src/errors";
import { profilePaths } from "../src/profiles";
// covers: headless.backup

/*
 * A write to a file may take only part of what it is given (a disk filling as it writes) and say so only in the
 * bytes it reports. The restore's last write, the last file's tail, has no write after it to meet the full disk: a
 * restore that took one write's word for it named a profile whose last file was cut short. It finishes the write, or
 * fails as a full disk does, leaving no profile.
 */

afterEach(() => { vi.restoreAllMocks(); });

type Write = (...args: unknown[]) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

const STORE = randomBytes(3000), FIRST = randomBytes(5000), LAST = randomBytes(300_000);

/** A backup with no passphrase, as `profile backup --no-passphrase` writes it: the store, then two files. */
async function backup(dir: string): Promise<string> {
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, null);
  const put = (record: object) => writer.json(JSON.stringify(record));
  await put({ t: "profile", format: "ghostly-cli-profile/2", createdAt: Date.now(), files: 2, bytes: FIRST.length + LAST.length });
  await put({ t: "file", kind: "store", size: STORE.length });
  await writer.bytes(STORE);
  await put({ t: "file", kind: "file", path: "first.bin", size: FIRST.length });
  await writer.bytes(FIRST);
  await put({ t: "file", kind: "file", path: "deep/last.bin", size: LAST.length });
  await writer.bytes(LAST);
  await put({ t: "end", files: 2, bytes: FIRST.length + LAST.length });
  await writer.finish();
  const file = join(dir, "made.ghostly-backup");
  writeFileSync(file, sink.bytes());
  return file;
}

/** `FileHandle.prototype.write`, as Node has it. */
async function handleWrite(dir: string): Promise<{ proto: { write: Write }; real: Write }> {
  const probe = await open(join(dir, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { write: Write };
  await probe.close();
  return { proto, real: proto.write };
}

/** How many writes a clean restore of `file` makes: the last of them is the last file's tail. */
async function writesOf(dir: string, file: string, proto: { write: Write }, real: Write): Promise<number> {
  let calls = 0;
  const spy = vi.spyOn(proto, "write").mockImplementation(function (this: unknown, ...args: unknown[]) { calls++; return real.apply(this, args); });
  await restoreProfile(dir, "clean", file);
  spy.mockRestore();
  return calls;
}

/** From write number `from` on, each write takes at most `room` of the bytes it is asked for. */
function shortFrom(proto: { write: Write }, real: Write, from: number, room: (length: number) => number) {
  let calls = 0;
  vi.spyOn(proto, "write").mockImplementation(function (this: unknown, ...args: unknown[]) {
    calls++;
    if (calls < from) return real.apply(this, args);
    const buffer = args[0] as Uint8Array, offset = (args[1] as number | undefined) ?? 0;
    const length = (args[2] as number | undefined) ?? buffer.length - offset;
    return real.call(this, buffer, offset, Math.min(length, room(length)), args[3] ?? null);
  });
}

const nothingLeft = (dir: string, name: string) => {
  expect(existsSync(profilePaths(dir, name).dir)).toBe(false);
  expect(readdirSync(join(dir, "profiles")).filter((entry) => entry.startsWith(".restoring-"))).toEqual([]);
};

it("finishes a last write the disk took only part of: the last file is restored whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-short-"));
  const file = await backup(dir);
  const { proto, real } = await handleWrite(dir);
  const total = await writesOf(dir, file, proto, real);
  // The last file's tail goes in 4 KiB at most per write from there on.
  shortFrom(proto, real, total, () => 4096);
  const paths = await restoreProfile(dir, "back", file);
  vi.restoreAllMocks();
  expect(readFileSync(join(paths.files, "deep", "last.bin")).equals(LAST)).toBe(true);
  expect(readFileSync(join(paths.files, "first.bin")).equals(FIRST)).toBe(true);
  expect(readFileSync(join(paths.db, "snapshot.bin")).equals(STORE)).toBe(true);
});

it("finishes a write the disk took only part of before the last file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-short-"));
  const file = await backup(dir);
  const { proto, real } = await handleWrite(dir);
  // Every write takes half of what it is asked for, the store's and the first file's included.
  shortFrom(proto, real, 1, (length) => Math.ceil(length / 2));
  const paths = await restoreProfile(dir, "back", file);
  vi.restoreAllMocks();
  expect(readFileSync(join(paths.db, "snapshot.bin")).equals(STORE)).toBe(true);
  expect(readFileSync(join(paths.files, "first.bin")).equals(FIRST)).toBe(true);
  expect(readFileSync(join(paths.files, "deep", "last.bin")).equals(LAST)).toBe(true);
});

it("fails as a full disk does when the last write takes nothing, and leaves no profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-short-"));
  const file = await backup(dir);
  const { proto, real } = await handleWrite(dir);
  const total = await writesOf(dir, file, proto, real);
  shortFrom(proto, real, total, () => 0);
  const error = await restoreProfile(dir, "back", file).then(() => null, (failure: unknown) => failure);
  vi.restoreAllMocks();
  const full = asCliError(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" }));
  expect(error).not.toBeNull();
  expect(asCliError(error)).toMatchObject({ code: "unavailable", message: full.message, details: full.details });
  nothingLeft(dir, "back");
});

it("fails as before when the disk answers ENOSPC on the last write, and leaves no profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-short-"));
  const file = await backup(dir);
  const { proto, real } = await handleWrite(dir);
  const total = await writesOf(dir, file, proto, real);
  let calls = 0;
  vi.spyOn(proto, "write").mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (++calls === total) return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" }));
    return real.apply(this, args);
  });
  const error = await restoreProfile(dir, "back", file).then(() => null, (failure: unknown) => failure);
  vi.restoreAllMocks();
  expect(asCliError(error)).toMatchObject({ code: "unavailable", message: "No room left on the disk: free some space, then try again" });
  nothingLeft(dir, "back");
});
