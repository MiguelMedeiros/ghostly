// covers: headless.backup
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

const FILES = 2_000;
const PASSPHRASE = "correct horse battery";

afterEach(() => { vi.restoreAllMocks(); });

// Each small file is two frames (its record, its bytes): a WebCrypto call and a write each took 16 s for 50,000 files.
it.each([["sealed", true], ["made without a passphrase", false]] as const)("a backup of many small files %s makes no async crypto call and no write per frame, and restores whole", async (_, sealed) => {
  const tag = sealed ? "sealed" : "none";
  const dir = home(`backup-many-files-${tag}`);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(join(paths.files, "sub"), { recursive: true });
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  for (let i = 0; i < FILES; i++) writeFileSync(join(paths.files, i % 2 ? "sub" : "", `file-${i}`), `file ${i} `.repeat(50));
  const probe = await open(join(dir, "probe"), "w");
  const write = vi.spyOn(Object.getPrototypeOf(probe) as { write: () => unknown }, "write");
  await probe.close();
  const encrypt = vi.spyOn(crypto.subtle, "encrypt"), digest = vi.spyOn(crypto.subtle, "digest");
  const out = join(dir, "out.ghostly-backup");
  const result = await BACKUP_METHODS["profile.backup"](ctx, sealed ? { path: out, passphrase: PASSPHRASE } : { path: out, noPassphrase: true });
  expect(result).toMatchObject({ files: FILES, protection: sealed ? "passphrase" : "none" });
  expect(encrypt.mock.calls.length + digest.mock.calls.length).toBeLessThan(10);
  expect(write.mock.calls.length).toBeLessThan(10);
  vi.restoreAllMocks();
  const restored = await restoreProfile(home(`backup-many-files-to-${tag}`), "back", out, sealed ? PASSPHRASE : undefined);
  expect(readFileSync(join(restored.db, "snapshot.bin")).toString()).toBe("STORE");
  expect(readdirSync(restored.files, { recursive: true }).length).toBe(FILES + 1);
  for (const i of [0, 1, FILES - 1]) {
    const name = join(i % 2 ? "sub" : "", `file-${i}`);
    expect(readFileSync(join(restored.files, name)).equals(readFileSync(join(paths.files, name)))).toBe(true);
  }
}, 120_000);
