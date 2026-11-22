import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FRAME_BYTES } from "@ghostly/browser/backup/stream";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

// Every buffer a file of the backup is read into.
const readInto = vi.hoisted(() => new Set<ArrayBufferLike>());
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle: FileHandle = await fs.open(...args);
      const read = handle.read.bind(handle) as (...rest: unknown[]) => ReturnType<FileHandle["read"]>;
      return Object.assign(handle, { read: (buffer: Uint8Array, ...rest: unknown[]) => { readInto.add(buffer.buffer); return read(buffer, ...rest); } });
    },
  };
});

// A buffer of a frame's size (1 MiB) for each file, even a 1 KB one: a profile with 50,000 small files zero-filled
// ~50 GB and left it to the GC, and its backup took half a minute.
it("a backup reads every file into one buffer, and each restores whole", async () => {
  const dir = home("backup-one-buffer");
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  for (let i = 0; i < 20; i++) writeFileSync(join(paths.files, `small-${i}`), `small file ${i} `.repeat(80));
  // Over two frames: read into the same buffer frame after frame.
  const large = new Uint8Array(2 * FRAME_BYTES + 123).map((_, i) => i * 7);
  writeFileSync(join(paths.files, "large"), large);
  readInto.clear();
  const result = await BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, "out.ghostly-backup"), passphrase: "correct horse battery" });
  expect(result).toMatchObject({ files: 21 });
  expect([...readInto].map((buffer) => buffer.byteLength)).toEqual([FRAME_BYTES]);
  const restored = await restoreProfile(home("backup-one-buffer-to"), "back", join(dir, "out.ghostly-backup"), "correct horse battery");
  expect(readdirSync(restored.files).sort()).toEqual(readdirSync(paths.files).sort());
  for (const name of readdirSync(paths.files)) expect(readFileSync(join(restored.files, name)).equals(readFileSync(join(paths.files, name)))).toBe(true);
});
