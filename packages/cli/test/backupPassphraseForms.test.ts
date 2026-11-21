import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { home } from "./support/cli";

const PASS = "correct horse battery";
/** What an older CLI read from a passphrase file: the bytes as UTF-8, one `\r?\n` at the end left out. */
const fromFile = (bytes: Buffer) => bytes.toString("utf8").replace(/\r?\n$/, "");

async function backUp(dir: string, passphrase: string): Promise<string> {
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  writeFileSync(join(paths.files, "note"), "a file of the profile");
  const store = { async exportSnapshot(path: string) { await writeFile(path, "STORE", { mode: 0o600 }); } };
  const ctx = { runtime: { paths, store } } as unknown as ApiContext;
  const out = join(dir, "out.ghostly-backup");
  await BACKUP_METHODS["profile.backup"](ctx, { path: out, passphrase });
  return out;
}

// Only one line break at a passphrase file's end was left out and the environment was taken as given: a backup sealed
// from a file with a second line break, a lone carriage return, a byte order mark or UTF-16 bytes opened with that file
// only, and the same passphrase from a password manager (the environment, a paste) was "Wrong passphrase". The other
// way round too: `GHOSTLY_BACKUP_PASSPHRASE="$(cat crlf-file)"` kept the carriage return.
it("a restore opens a backup whose passphrase was read with a line break, carriage return, BOM or UTF-16 at its ends, and the other way round", async () => {
  const sealedWith = {
    "a second line break": fromFile(Buffer.from(`${PASS}\n\n`)),
    "a lone carriage return": fromFile(Buffer.from(`${PASS}\r`)),
    "a byte order mark and CRLF (Notepad)": fromFile(Buffer.from(`\uFEFF${PASS}\r\n`)),
    "UTF-16 with a BOM and CRLF (PowerShell >)": fromFile(Buffer.from(`\uFEFF${PASS}\r\n`, "utf16le")),
  };
  for (const [what, sealed] of Object.entries(sealedWith)) {
    expect(sealed, what).not.toBe(PASS);
    const out = await backUp(home("backup-forms"), sealed);
    const restored = await restoreProfile(home("backup-forms-to"), "back", out, PASS);
    expect(readFileSync(join(restored.files, "note"), "utf8"), what).toBe("a file of the profile");
  }

  const out = await backUp(home("backup-forms-clean"), PASS);
  const givenAs = {
    "a carriage return from $(cat crlf-file)": `${PASS}\r`,
    "a trailing space": `${PASS} `,
    "a byte order mark": fromFile(Buffer.from(`\uFEFF${PASS}\r\n`)),
    "UTF-16": fromFile(Buffer.from(`\uFEFF${PASS}\r\n`, "utf16le")),
  };
  for (const [what, given] of Object.entries(givenAs)) {
    const restored = await restoreProfile(home("backup-forms-to"), "back", out, given);
    expect(readFileSync(join(restored.files, "note"), "utf8"), what).toBe("a file of the profile");
  }

  // A wrong passphrase is still that, and leaves no profile.
  const to = home("backup-forms-wrong");
  await expect(restoreProfile(to, "back", out, "not the passphrase\r")).rejects.toThrow("Wrong passphrase, or the backup was changed");
  await expect(restoreProfile(to, "back", out, "  ")).rejects.toThrow("Wrong passphrase, or the backup was changed");
  expect(existsSync(join(to, "profiles", "back"))).toBe(false);
}, 120_000);
