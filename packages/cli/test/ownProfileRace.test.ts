import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ownProfile } from "../src/privateFolder";
import { profilePaths } from "../src/profiles";
// covers: headless.cli

/** Files another command removes between the listing and the look at each: gone when this one reaches them. */
const vanishing = new Set<string>();

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const readdirSync = ((path: string, ...rest: unknown[]) => {
    const names = (real.readdirSync as (...args: unknown[]) => string[])(path, ...rest);
    for (const name of names) {
      const file = join(String(path), name);
      if (vanishing.has(file)) real.rmSync(file, { force: true });
    }
    return names;
  }) as typeof real.readdirSync;
  return { ...real, default: { ...real, readdirSync }, readdirSync };
});

const root = mkdtempSync(join(tmpdir(), "gh-own-race-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * One-shots at once on one profile: each checks the profile's files before it takes the lock, while the others write
 * and remove their lock's draft, start (`<lock>.<pid>.start`) and stale files. One removed between the listing and the
 * check ended the command `not_found` on that file.
 */
describe.skipIf(process.platform === "win32")("the profile's files checked beside other commands", () => {
  it("a file another command removes while they are checked is passed over, not an error", () => {
    const paths = profilePaths(join(root, "home"), "default");
    mkdirSync(join(paths.dir, "db"), { recursive: true, mode: 0o700 });
    const start = `${paths.lock}.15644.start`, draft = `${paths.lock}.15644`, journal = join(paths.dir, "db", "gone.log");
    for (const file of [start, draft, journal]) {
      writeFileSync(file, "x", { mode: 0o644 });
      vanishing.add(file);
    }
    writeFileSync(join(paths.dir, "kept"), "x", { mode: 0o644 });
    expect(() => ownProfile(paths.dir)).not.toThrow();
    expect(existsSync(start)).toBe(false);
    expect(fs.statSync(join(paths.dir, "kept")).mode & 0o777).toBe(0o600);
  });
});
