import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS } from "../src/backup";
import { profilePaths } from "../src/profiles";
import { ghostly, home, ok, Running } from "./support/cli";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.backup, headless.daemon, headless.cli

/*
 * The store a backup writes for itself into the profile's db folder (every message, key and setting, in the clear)
 * goes on every way the backup ends: one that fails, one stopped with Ctrl-C (a one-shot leaves before its own cleanup
 * ran), and one whose process was killed (gone at the profile's next start). Left there, it outlived what the person
 * deleted since. The half-written backup beside --out goes with it.
 */
function profile(name: string) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  return paths;
}

const backup = (paths: ReturnType<typeof profile>, store: { exportSnapshot(path: string): Promise<void> }) =>
  BACKUP_METHODS["profile.backup"]({ runtime: { paths, store } } as unknown as ApiContext, { path: join(paths.dir, "out.ghostly-backup"), noPassphrase: true });

describe("a backup that fails", () => {
  it("on a file it cannot read the size of, after the store's export, leaves no store behind", async () => {
    const paths = profile("backup-loop-file");
    // A link to itself: its stat fails (ELOOP), and not as a file gone meanwhile, which the walk leaves out.
    symlinkSync(join(paths.files, "f1"), join(paths.files, "f1"));
    await expect(backup(paths, { exportSnapshot: async (path) => writeFileSync(path, "STORE", { mode: 0o600 }) })).rejects.toThrow(/ELOOP/);
    expect(readdirSync(paths.db)).toEqual([]);
    expect(readdirSync(paths.dir).sort()).toEqual(["db", "files"]);
  });

  it("in the middle of writing the store (a disk full) leaves no part of it behind", async () => {
    const paths = profile("backup-store-cut");
    const exportSnapshot = async (path: string) => {
      const file = await open(path, "w", 0o600);
      try { await file.write("STORE-PART"); } finally { await file.close(); }
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
    await expect(backup(paths, { exportSnapshot })).rejects.toThrow();
    expect(readdirSync(paths.db)).toEqual([]);
  });
});

describe("a profile's start", { timeout: 120_000 }, () => {
  const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
  const before: Record<string, string | undefined> = {};
  beforeAll(() => { for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; } });
  afterAll(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  it("removes the store a backup stopped mid-way left in its db folder, and nothing else", async () => {
    const paths = profilePaths(home("backup-store-killed"), "p");
    mkdirSync(paths.db, { recursive: true, mode: 0o700 });
    // As an older CLI named it, and as this one does.
    writeFileSync(join(paths.db, "backup-store-4242.bin"), "STORE", { mode: 0o600 });
    writeFileSync(join(paths.db, "backup-store-4242-0a1b2c3d4e5f.bin"), "STORE", { mode: 0o600 });
    const { openHost } = await import("../src/host");
    const host = await openHost(paths, "one-shot", "test");
    try {
      expect(readdirSync(paths.db).filter((name) => name.startsWith("backup-store-"))).toEqual([]);
      expect(readdirSync(paths.db).length).toBeGreaterThan(0);
    } finally { await host.close(); }
  });
});

describe("a one-shot backup stopped with Ctrl-C", { timeout: 120_000 }, () => {
  it("leaves neither the store in db/ nor the half-written backup beside --out", async () => {
    const dir = home("backup-interrupt");
    const paths = profilePaths(dir, "default");
    ok(await ghostly(["--home", dir, "status"]));
    mkdirSync(paths.files, { recursive: true });
    for (let i = 0; i < 24; i++) writeFileSync(join(paths.files, `f${i}`), randomBytes(1 << 20));
    // Every write slowed down, so Ctrl-C finds the backup half-way.
    const slow = join(dir, "slow-writes.cjs");
    writeFileSync(slow, `require("node:fs/promises").open(__filename, "r").then((handle) => {
  const proto = Object.getPrototypeOf(handle), write = proto.write;
  proto.write = async function (...args) { await new Promise((done) => setTimeout(done, 25)); return write.apply(this, args); };
  return handle.close();
});
`);
    const outDir = join(dir, "out");
    mkdirSync(outDir);
    const run = new Running(["--home", dir, "profile", "backup", "--out", join(outDir, "b.ghostly-backup"), "--no-passphrase"], { NODE_OPTIONS: `--require "${slow}"` });
    const until = Date.now() + 60_000;
    while (!readdirSync(outDir).some((name) => name.includes(".partial-"))) {
      if (run.child.exitCode !== null || Date.now() > until) throw new Error(`no backup under way\n${run.stderr}\n${JSON.stringify(run.lines)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readdirSync(paths.db).some((name) => name.startsWith("backup-store-"))).toBe(true);
    run.child.kill("SIGINT");
    expect(await run.exited(20_000)).toBe(130);
    expect(readdirSync(paths.db).filter((name) => name.startsWith("backup-store-"))).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });
});
