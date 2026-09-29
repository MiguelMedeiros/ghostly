import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.backup

it("backs a profile up under a passphrase and restores it into a new one, never over an existing one", async () => {
  const dir = home("backup");
  const env = { GHOSTLY_BACKUP_PASSPHRASE: "correct horse battery staple" };
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Backup bot"]));
  const file = join(dir, "bot.ghostly-backup");
  error(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env: { GHOSTLY_BACKUP_PASSPHRASE: "short" } }), "bad_request", 1);
  const made = ok(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env }));
  expect(made).toMatchObject({ path: file });
  expect(readFileSync(file, "utf8")).toContain('"format":"ghostly-backup"');
  expect(readFileSync(file, "utf8")).not.toContain("Backup bot");
  error(await ghostly(["--home", dir, "profile", "backup", "--out", file], { env }), "confirm", 5);

  const wrong = join(dir, "wrong");
  writeFileSync(wrong, "not the passphrase\n");
  error(await ghostly(["--home", dir, "profile", "restore", file, "copy", "--passphrase-file", wrong]), "refused", 1);
  error(await ghostly(["--home", dir, "profile", "restore", file, "default"], { env }), "refused", 1);
  ok(await ghostly(["--home", dir, "profile", "restore", file, "copy"], { env }));
  expect(ok(await ghostly(["--home", dir, "--profile", "copy", "profile", "show"]))).toMatchObject({ profile: "copy", name: "Backup bot" });
});
