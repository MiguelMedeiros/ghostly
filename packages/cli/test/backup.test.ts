import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seal } from "@ghostly/browser/backup/envelope";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.backup

const PASS = { GHOSTLY_BACKUP_PASSPHRASE: "correct horse battery staple" };
/** Nothing of the environment's passphrase, whatever the shell running the tests holds. */
const NO_PASS = { GHOSTLY_BACKUP_PASSPHRASE: "" };
const header = (file: string) => { const bytes = readFileSync(file); return JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString("utf8")) as Record<string, unknown>; };
const pattern = (length: number, seed: number) => { const out = Buffer.alloc(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };

it("backs a profile up under a passphrase and restores it into a new one, never over an existing one", async () => {
  const dir = home("backup");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Backup bot"]));
  const file = join(dir, "bot.ghostly-backup");
  error(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: { GHOSTLY_BACKUP_PASSPHRASE: "short" } }), "bad_request", 1);
  expect(readdirSync(dir).filter((name) => name.includes("ghostly-backup")), "a refused backup leaves no file, whole or partial").toEqual([]);
  const made = ok(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: PASS }));
  expect(made).toMatchObject({ path: file, protection: "passphrase", bytes: statSync(file).size });
  expect(header(file)).toMatchObject({ format: "ghostly-backup", version: 2, protection: "passphrase", kdf: { name: "PBKDF2-SHA256", iterations: 600_000 }, cipher: { name: "AES-256-GCM" } });
  expect(readFileSync(file, "latin1")).not.toContain("Backup bot");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).filter((name) => name.includes(".partial")), "the file being written took its name only when whole").toEqual([]);
  error(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: PASS }), "confirm", 5);

  const wrong = join(dir, "wrong");
  writeFileSync(wrong, "not the passphrase\n");
  error(await ghostly(["--home", dir, "profile", "restore", file, "copy", "--passphrase-file", wrong]), "refused", 1);
  error(await ghostly(["--home", dir, "profile", "restore", file, "default"], { env: PASS }), "refused", 1);
  error(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: NO_PASS }), "usage", 2);
  expect(ok(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: PASS }))).toMatchObject({ restored: "copy", protection: "passphrase" });
  expect(ok(await ghostly(["--home", dir, "--profile", "copy", "profile", "show"]))).toMatchObject({ profile: "copy", name: "Backup bot" });
});

it("a profile's files travel with it, large ones too, and a damaged or cut backup restores nothing", async () => {
  const dir = home("backup-files");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Files bot"]));
  // Files as the engine keeps them: real files under the profile's files folder, of any size.
  const files = join(dir, "profiles", "default", "files", "ghostly");
  mkdirSync(files, { recursive: true });
  const big = pattern(5 * 1024 * 1024 + 7, 1);
  writeFileSync(join(files, "chat-in-big"), big);
  for (let i = 0; i < 40; i++) writeFileSync(join(files, `chat-in-${i}`), pattern(2000 + i, i));
  writeFileSync(join(files, "chat-in-empty"), "");

  const file = join(dir, "files.ghostly-backup");
  expect(ok(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: PASS }))).toMatchObject({ files: 42 });
  const restored = ok(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: PASS })) as { folder: string };
  const copied = join(restored.folder, "files", "ghostly");
  expect(readdirSync(copied).length).toBe(42);
  expect(readFileSync(join(copied, "chat-in-big")).equals(big)).toBe(true);
  expect(readFileSync(join(copied, "chat-in-17")).equals(pattern(2017, 17))).toBe(true);
  expect(statSync(join(copied, "chat-in-empty")).size).toBe(0);
  expect(ok(await ghostly(["--home", dir, "--profile", "copy", "profile", "show"]))).toMatchObject({ name: "Files bot" });

  // Changed in the middle, or cut short: refused, and no half-made profile stays.
  const bytes = readFileSync(file);
  const changed = Buffer.from(bytes); changed[Math.floor(bytes.length / 2)] ^= 1;
  writeFileSync(join(dir, "changed.ghostly-backup"), changed);
  writeFileSync(join(dir, "cut.ghostly-backup"), bytes.subarray(0, bytes.length - 21));
  for (const damaged of ["changed.ghostly-backup", "cut.ghostly-backup"]) {
    expect(error(await ghostly(["--home", dir, "profile", "restore", join(dir, damaged), "broken"], { env: PASS }), "refused", 1).message).toContain("damaged");
    expect(readdirSync(join(dir, "profiles")).sort()).toEqual(["copy", "default"]);
  }
});

it("a backup without a passphrase is made only when asked for by name, says so, and restores with none", async () => {
  const dir = home("backup-open");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Open bot"]));
  const file = join(dir, "open.ghostly-backup");
  // Neither a passphrase nor the flag: nothing is made, and the message names the flag.
  expect(error(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: NO_PASS }), "usage", 2).message).toContain("--no-passphrase");
  // Both: refused, not guessed.
  expect(error(await ghostly(["--home", dir, "profile", "backup", "--out", file, "--no-passphrase"], { env: PASS }), "usage", 2).message).toContain("choose one");
  error(await ghostly(["--home", dir, "profile", "backup", "--out", file, "--passphrase"], { env: NO_PASS }), "usage", 2);
  expect(readdirSync(dir).filter((name) => name.includes("ghostly-backup"))).toEqual([]);

  const run = await ghostly(["--home", dir, "profile", "backup", "--out", file, "--no-passphrase"], { env: NO_PASS });
  expect(ok(run)).toMatchObject({ path: file, protection: "none" });
  expect(run.stderr).toContain("Not encrypted: this file holds the profile's keys, chats and wallet secrets in the clear.");
  expect(header(file)).toEqual({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } });
  // No passphrase is asked for, and one in the environment is not needed.
  expect(ok(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: NO_PASS }))).toMatchObject({ restored: "copy", protection: "none" });
  expect(ok(await ghostly(["--home", dir, "--profile", "copy", "profile", "show"]))).toMatchObject({ name: "Open bot" });
  // Still checked: a changed byte is refused.
  const bytes = Buffer.from(readFileSync(file)); bytes[bytes.length - 50] ^= 1;
  writeFileSync(join(dir, "changed.ghostly-backup"), bytes);
  error(await ghostly(["--home", dir, "profile", "restore", join(dir, "changed.ghostly-backup"), "broken"], { env: NO_PASS }), "refused", 1);
});

it("a backup an older CLI made (version 1) still restores", async () => {
  const dir = home("backup-v1");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Old bot"]));
  // As the CLI wrote it until now: the store and every file as base64 in one sealed JSON document.
  const store = readFileSync(join(dir, "profiles", "default", "db", "snapshot.bin")).toString("base64");
  const payload = { format: "ghostly-cli-profile/1", createdAt: 1, store, files: [{ path: "ghostly/chat-in-a", data: pattern(3000, 3).toString("base64") }] };
  const file = join(dir, "old.ghostly-backup");
  writeFileSync(file, await seal(JSON.stringify(payload), PASS.GHOSTLY_BACKUP_PASSPHRASE));
  error(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: { GHOSTLY_BACKUP_PASSPHRASE: "not the passphrase" } }), "refused", 1);
  const restored = ok(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env: PASS })) as { folder: string };
  expect(restored).toMatchObject({ restored: "copy", protection: "passphrase" });
  expect(readFileSync(join(restored.folder, "files", "ghostly", "chat-in-a")).equals(pattern(3000, 3))).toBe(true);
  expect(ok(await ghostly(["--home", dir, "--profile", "copy", "profile", "show"]))).toMatchObject({ name: "Old bot" });
});
