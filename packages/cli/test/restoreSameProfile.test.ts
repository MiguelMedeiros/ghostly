import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { error, ghostly, home, ok, Running } from "./support/cli";
// covers: headless.backup

const NO_PASS = { GHOSTLY_BACKUP_PASSPHRASE: "" };
const profiles = (dir: string) => readdirSync(join(dir, "profiles")).sort();

it("a backup of a profile still in the home is refused as the same person, names the profiles, and restores with --copy", { timeout: 120_000 }, async () => {
  const dir = home("restore-same");
  ok(await ghostly(["--home", dir, "profile", "set", "--name", "Alice"]));
  const file = join(dir, "alice.ghostly-backup");
  ok(await ghostly(["--home", dir, "profile", "backup", "--out", file, "--no-passphrase"], { env: NO_PASS }));

  // The original runs meanwhile: its store is read beside the daemon that holds it.
  const daemon = new Running(["--home", dir, "daemon"]);
  try {
    await daemon.waitFor((line) => line.daemon === "ready");
    const refused = error(await ghostly(["--home", dir, "profile", "restore", file, "bob"], { env: NO_PASS }), "refused", 1) as { message: string; details?: unknown };
    expect(refused.details).toEqual({ reason: "same-profile", profiles: ["default"] });
    expect(refused.message).toContain("default");
    expect(refused.message).toContain("--copy");
    expect(profiles(dir), "nothing is written, not even a folder being restored").toEqual(["default"]);

    expect(ok(await ghostly(["--home", dir, "profile", "restore", file, "bob", "--copy"], { env: NO_PASS }))).toMatchObject({ restored: "bob" });
    // The copy is one more profile of the same person: a third restore names both.
    const again = error(await ghostly(["--home", dir, "profile", "restore", file, "carol"], { env: NO_PASS }), "refused", 1) as { details?: unknown };
    expect(again.details).toEqual({ reason: "same-profile", profiles: ["bob", "default"] });
    expect(profiles(dir)).toEqual(["bob", "default"]);
  } finally { await daemon.stop(); }

  // Another person's profile in the home is no match: a backup of it restores without the flag.
  const other = home("restore-other");
  ok(await ghostly(["--home", other, "profile", "set", "--name", "Dave"]));
  const daves = join(other, "dave.ghostly-backup");
  ok(await ghostly(["--home", other, "profile", "backup", "--out", daves, "--no-passphrase"], { env: NO_PASS }));
  expect(ok(await ghostly(["--home", dir, "profile", "restore", daves, "dave"], { env: NO_PASS }))).toMatchObject({ restored: "dave" });
});
