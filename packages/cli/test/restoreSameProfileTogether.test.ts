import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.backup

const NO_PASS = { GHOSTLY_BACKUP_PASSPHRASE: "" };
const profiles = (dir: string) => readdirSync(join(dir, "profiles")).sort();

// Neither restore sees the other's profile while it is still being restored: the check runs again, one restore at a
// time, just before the folder takes its name.
it("two restores of one backup started together: one restores, the other is refused as the same person, nothing left behind", { timeout: 120_000 }, async () => {
  const original = home("restore-together-original");
  ok(await ghostly(["--home", original, "profile", "set", "--name", "Alice"]));
  // Its files are written after its store: with a large one, each restore is still writing when the other checks.
  mkdirSync(join(original, "profiles", "default", "files"), { recursive: true });
  writeFileSync(join(original, "profiles", "default", "files", "large.bin"), randomBytes(32 * 1024 * 1024));
  const file = join(original, "alice.ghostly-backup");
  ok(await ghostly(["--home", original, "profile", "backup", "--out", file, "--no-passphrase"], { env: NO_PASS }));

  // A home without the original, as on a new device.
  const dir = home("restore-together");
  const both = await Promise.all(["one", "two"].map((name) => ghostly(["--home", dir, "profile", "restore", file, name], { env: NO_PASS })));
  const restored = both.filter((result) => result.code === 0);
  expect(restored, "exactly one restores").toHaveLength(1);
  const winner = restored[0]!.json.restored as string;
  const refused = both.find((result) => result.code !== 0)!.json.error as { code?: string; details?: unknown };
  expect(refused.code).toBe("confirm");
  expect(refused.details).toEqual({ reason: "same-profile", profiles: [winner] });
  expect(profiles(dir), "no folder being restored, no lock").toEqual([winner]);

  // --copy still lets both through.
  const copies = home("restore-together-copy");
  const all = await Promise.all(["one", "two"].map((name) => ghostly(["--home", copies, "profile", "restore", file, name, "--copy"], { env: NO_PASS })));
  for (const result of all) ok(result);
  expect(profiles(copies)).toEqual(["one", "two"]);
});

it("a restore lock left by a restore that died is not waited for", { timeout: 60_000 }, async () => {
  const original = home("restore-dead-lock-original");
  ok(await ghostly(["--home", original, "profile", "set", "--name", "Alice"]));
  const file = join(original, "alice.ghostly-backup");
  ok(await ghostly(["--home", original, "profile", "backup", "--out", file, "--no-passphrase"], { env: NO_PASS }));
  const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
  const dir = home("restore-dead-lock");
  mkdirSync(join(dir, "profiles"), { recursive: true });
  writeFileSync(join(dir, "profiles", ".restore.lock"), String(gone));
  const started = Date.now();
  expect(ok(await ghostly(["--home", dir, "profile", "restore", file, "alice"], { env: NO_PASS }))).toMatchObject({ restored: "alice" });
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(profiles(dir)).toEqual(["alice"]);
});
