import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { ghostly, home, ok, Running } from "./support/cli";
// covers: headless.backup, headless.cli

/*
 * A restore writes the profile in the clear (its whole store, its files) into a hidden folder beside the profiles, and
 * gives it the profile's name once it is whole. Stopped while it runs (Ctrl-C, a service manager's stop, the terminal
 * closing), that folder goes with it: the person who stopped it was told nothing was restored. One a killed process
 * left goes the next time the profiles are listed.
 */
const restoring = (dir: string) => readdirSync(join(dir, "profiles")).filter((name) => name.startsWith(".restoring-"));

describe("a restore stopped while it runs", { timeout: 180_000 }, () => {
  const dir = home("restore-interrupt");
  const file = join(dir, "big.ghostly-backup");
  // Every write slowed down, so the signal finds the restore half-way.
  const slow = join(dir, "slow-writes.cjs");

  beforeAll(async () => {
    const paths = profilePaths(dir, "default");
    ok(await ghostly(["--home", dir, "status"]));
    mkdirSync(paths.files, { recursive: true });
    for (let i = 0; i < 24; i++) writeFileSync(join(paths.files, `f${i}`), randomBytes(1 << 20));
    ok(await ghostly(["--home", dir, "profile", "backup", "--out", file, "--no-passphrase"]));
    writeFileSync(slow, `require("node:fs/promises").open(__filename, "r").then((handle) => {
  const proto = Object.getPrototypeOf(handle), write = proto.write;
  proto.write = async function (...args) { await new Promise((done) => setTimeout(done, 25)); return write.apply(this, args); };
  return handle.close();
});
`);
  }, 180_000);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`by ${signal} leaves neither the profile nor its decrypted contents, and says so`, async () => {
      const name = `r-${signal.toLowerCase()}`;
      const run = new Running(["--home", dir, "profile", "restore", file, name, "--copy"], { NODE_OPTIONS: `--require "${slow}"` });
      const until = Date.now() + 60_000;
      while (!restoring(dir).some((entry) => entry.startsWith(`.restoring-${name}-`) && existsSync(join(dir, "profiles", entry, "db", "snapshot.bin")))) {
        if (run.child.exitCode !== null || Date.now() > until) throw new Error(`no restore under way\n${run.stderr}\n${JSON.stringify(run.lines)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      run.child.kill(signal);
      expect(await run.exited(20_000)).toBe(130);
      expect(restoring(dir)).toEqual([]);
      expect(existsSync(profilePaths(dir, name).dir)).toBe(false);
      expect(run.lines.at(-1)).toMatchObject({ error: { code: "interrupted" } });
      expect(run.stderr).toMatch(/^ghostly: .*no profile was made/m);
    });
  }

  it("one a killed process left is removed when the profiles are listed; a live one's stays", async () => {
    // A process id that was in use and is no more.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const left = join(dir, "profiles", `.restoring-gone-${dead}`), live = join(dir, "profiles", `.restoring-busy-${process.pid}`);
    for (const folder of [left, live]) {
      mkdirSync(join(folder, "db"), { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, "db", "snapshot.bin"), "STORE", { mode: 0o600 });
    }
    const listed = ok(await ghostly(["--home", dir, "profile", "list"])) as { profiles: { name: string }[] };
    expect(listed.profiles.map((profile) => profile.name)).toEqual(["default"]);
    expect(restoring(dir)).toEqual([`.restoring-busy-${process.pid}`]);
  });
});
