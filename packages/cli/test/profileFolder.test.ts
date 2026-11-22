import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli, headless.daemon

/*
 * A profile's folders and files are checked by every command that opens it, a one-shot as much as the daemon, and
 * before the lock or the store is written (WISP 1100 § Profiles and files). Only the daemon's socket check did: a
 * one-shot command used a profile folder, a home or an events journal opened up by hand as they were, and followed a
 * profile folder that was a link into a folder others could read.
 */
const mode = (path: string) => lstatSync(path).mode & 0o777;
let umask: number;
beforeAll(() => { umask = process.umask(0o022); });
afterAll(() => { process.umask(umask); });

describe.skipIf(process.platform === "win32")("the profile's folder, for every command", { timeout: 120_000 }, () => {
  it("a profile opened up by hand is closed again by a one-shot command", async () => {
    const dir = home("profile-opened");
    ok(await ghostly(["--home", dir, "invite", "create"]));
    const profile = join(dir, "profiles", "default");
    chmodSync(profile, 0o755);
    chmodSync(join(profile, "db"), 0o777);
    chmodSync(join(profile, "events.jsonl"), 0o644);
    for (const name of readdirSync(join(profile, "db"))) chmodSync(join(profile, "db", name), 0o666);
    ok(await ghostly(["--home", dir, "chat", "list"]));
    expect(mode(profile)).toBe(0o700);
    expect(mode(join(profile, "db"))).toBe(0o700);
    expect(mode(join(profile, "events.jsonl"))).toBe(0o600);
    for (const name of readdirSync(join(profile, "db"))) expect(mode(join(profile, "db", name)), name).toBe(0o600);
  });

  it("a home and profiles/ others may write, with journals made beforehand, are closed before the first one-shot writes", async () => {
    const dir = home("profile-home-open");
    const profile = join(dir, "profiles", "default");
    mkdirSync(join(profile, "db"), { recursive: true });
    for (const folder of [dir, join(dir, "profiles"), profile]) chmodSync(folder, 0o777);
    for (const file of [join(profile, "events.jsonl"), join(profile, "db", "journal.bin")]) { writeFileSync(file, ""); chmodSync(file, 0o666); }
    ok(await ghostly(["--home", dir, "invite", "create"]));
    expect(mode(dir) & 0o022).toBe(0);
    expect(mode(join(dir, "profiles"))).toBe(0o700);
    expect(mode(profile)).toBe(0o700);
    expect(statSync(join(profile, "events.jsonl")).size).toBeGreaterThan(0);
    expect(mode(join(profile, "events.jsonl"))).toBe(0o600);
    expect(mode(join(profile, "db", "journal.bin"))).toBe(0o600);
  });

  it("a profile folder that is a link is refused before anything is written there, by a one-shot and by the daemon", async () => {
    const dir = home("profile-link");
    const elsewhere = home("profile-link-target");
    chmodSync(elsewhere, 0o777);
    writeFileSync(join(elsewhere, "events.jsonl"), "");
    chmodSync(join(elsewhere, "events.jsonl"), 0o666);
    mkdirSync(join(dir, "profiles"), { mode: 0o700 });
    symlinkSync(elsewhere, join(dir, "profiles", "default"));
    expect(error(await ghostly(["--home", dir, "invite", "create"]), "refused", 1).message).toMatch(/not a folder of this user's/);
    expect(error(await ghostly(["--home", dir, "daemon", "--detach"]), "refused", 1).message).toMatch(/not a folder of this user's/);
    expect(readdirSync(elsewhere)).toEqual(["events.jsonl"]);
    expect(statSync(join(elsewhere, "events.jsonl")).size).toBe(0);
    expect(existsSync(join(elsewhere, "db"))).toBe(false);
  });

  it("a link in the profile's folder or its db/ is refused", async () => {
    const dir = home("profile-file-link");
    ok(await ghostly(["--home", dir, "invite", "create"]));
    const profile = join(dir, "profiles", "default");
    const outside = join(home("profile-file-link-target"), "events.jsonl");
    writeFileSync(outside, "");
    rmSync(join(profile, "events.jsonl"));
    symlinkSync(outside, join(profile, "events.jsonl"));
    expect(error(await ghostly(["--home", dir, "chat", "list"]), "refused", 1).message).toMatch(/is a link or another user's/);
    expect(statSync(outside).size).toBe(0);
  });
});
