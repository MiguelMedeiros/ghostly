import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createProfileKey, type ProfileKeyRecord } from "@ghostly/browser/shared/profileKey";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { PROFILE_KEY, readPassphrase, readProfileKey, tryProfileKey, writeProfileKey } from "../src/profileKey";
import { BIN, error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running, testEnv } from "./support/cli";
// covers: headless.daemon, headless.cli

/**
 * An encrypted profile's start gate on the CLI (WISP 04, Encrypted profile, Headless clients): with
 * `<profile>/profile-key.json` there, the daemon and a one-shot with no daemon open its data key with the passphrase
 * (from --passphrase-file, a path or /dev/fd/<n>, else GHOSTLY_PROFILE_PASSPHRASE, else a terminal) before the engine
 * starts, and refuse with a usage error when none is given. `profile passphrase` rewraps the key.
 */
const PASSPHRASE = "correct horse battery staple";
const NEXT = "another passphrase, longer";

describe("an encrypted CLI profile asks its passphrase before the engine starts", { timeout: 180_000 }, () => {
  let relay: { url: string; server: HttpServer };
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const dirs: string[] = [];

  beforeAll(async () => {
    relay = await localRelay();
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url };
  }, 30_000);

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => ghostly(["--home", dir, "daemon", "stop"], { env: { ...env, GHOSTLY_PROFILE_PASSPHRASE: PASSPHRASE } })));
    await dht?.destroy();
    relay?.server.close();
  }, 60_000);

  /** A profile with a chat, then its key record written: the profile is encrypted from here on. */
  async function encrypted(name: string): Promise<{ dir: string; folder: string; passphraseFile: string }> {
    const dir = home(name);
    dirs.push(dir);
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const folder = profilePaths(dir, "default").dir;
    const { record } = await createProfileKey(PASSPHRASE, "");
    writeProfileKey(folder, record);
    const passphraseFile = join(dir, "passphrase");
    writeFileSync(passphraseFile, PASSPHRASE + "\n", { mode: 0o600 });
    return { dir, folder, passphraseFile };
  }

  /** The store's files as they are: nothing of the engine ran when they did not change. */
  const storeState = (folder: string) => readdirSync(join(folder, "db")).map((name) => `${name}:${statSync(join(folder, "db", name)).mtimeMs}`).sort().join(",");

  it("the daemon refuses to start without a passphrase, with a usage error before the engine starts", async () => {
    const { dir, folder } = await encrypted("enc-refuse");
    const before = storeState(folder);
    const refused = error(await ghostly(["--home", dir, "daemon"], { env }), "usage", 2);
    expect(refused.message).toBe("Profile default is encrypted: its passphrase comes from --passphrase-file, GHOSTLY_PROFILE_PASSPHRASE or a terminal");
    error(await ghostly(["--home", dir, "daemon", "--detach", "--timeout", "20"], { env }), "usage", 2);
    // A one-shot with no daemon too.
    error(await ghostly(["--home", dir, "profile", "show"], { env }), "usage", 2);
    expect(existsSync(profilePaths(dir, "default").lock)).toBe(false);
    expect(storeState(folder)).toBe(before);
  });

  it("a wrong passphrase is one error, \"Wrong passphrase\", and nothing starts; the right one starts the daemon", async () => {
    const { dir, folder, passphraseFile } = await encrypted("enc-wrong");
    const wrong = join(dir, "wrong");
    writeFileSync(wrong, "not the passphrase at all");
    const before = storeState(folder);
    const answer = error(await ghostly(["--home", dir, "daemon", "--passphrase-file", wrong], { env }), "refused", 1);
    expect(answer.message).toBe("Wrong passphrase");
    error(await ghostly(["--home", dir, "profile", "show"], { env: { ...env, GHOSTLY_PROFILE_PASSPHRASE: "not the passphrase at all" } }), "refused", 1);
    expect(storeState(folder)).toBe(before);
    expect(existsSync(profilePaths(dir, "default").lock)).toBe(false);
    // The right one, from a file: the daemon runs, and a command through it needs no passphrase.
    const daemon = new Running(["--home", dir, "daemon", "--passphrase-file", passphraseFile], env);
    try {
      await daemon.waitFor((line) => line.daemon === "ready");
      expect(ok(await ghostly(["--home", dir, "profile", "show"], { env }))).toBeTruthy();
    } finally { await daemon.stop(); }
  });

  it("starts with the passphrase on a descriptor (/dev/fd/3), and --detach hands it to its child on one", async () => {
    const { dir } = await encrypted("enc-fd");
    // In the foreground, from a pipe this process writes: nothing on the command line or in the environment.
    const child = spawn(process.execPath, [BIN, "--home", dir, "daemon", "--passphrase-file", "/dev/fd/3"], { env: testEnv(env), stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const pipe = child.stdio[3] as NodeJS.WritableStream;
    pipe.end(PASSPHRASE);
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on("line", (line) => { try { const json = JSON.parse(line); if (json.daemon === "ready" || json.error) resolve(json); } catch { /* not JSON */ } });
      child.once("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    expect(ready.daemon).toBe("ready");
    ok(await ghostly(["--home", dir, "daemon", "stop"], { env }));
    // In the background, from the environment: the child gets it on its own pipe, and its arguments do not hold it.
    const started = ok(await ghostly(["--home", dir, "daemon", "--detach", "--timeout", "60"], { env: { ...env, GHOSTLY_PROFILE_PASSPHRASE: PASSPHRASE } }));
    expect(started.daemon).toBe("started");
    expect(readFileSync(profilePaths(dir, "default").log, "utf8")).not.toContain(PASSPHRASE);
    // A restart checks it before it stops the running daemon: without one, the daemon keeps running.
    error(await ghostly(["--home", dir, "daemon", "restart"], { env }), "usage", 2);
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env })).running).toBe(true);
    ok(await ghostly(["--home", dir, "daemon", "stop"], { env }));
  });

  it("a one-shot opens the profile with the passphrase from the environment, and its secrets are sealed", async () => {
    const { dir, folder } = await encrypted("enc-oneshot");
    const unlocked = { ...env, GHOSTLY_PROFILE_PASSPHRASE: PASSPHRASE };
    const made = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env: unlocked }));
    const invite = String(made.invite);
    expect(invite).toMatch(/^ghostly1/);
    // Read back through the sealed fields.
    const chats = JSON.stringify(ok(await ghostly(["--home", dir, "chat", "list"], { env: unlocked })));
    expect(chats).toContain(String(made.chat));
    // The store holds the invite sealed: its text is nowhere in the store's files.
    for (const name of readdirSync(join(folder, "db"))) expect(readFileSync(join(folder, "db", name)).includes(invite), name).toBe(false);
  });

  it("profile passphrase rewraps the key: the old one no longer opens it, the new one does", async () => {
    const { dir, folder, passphraseFile } = await encrypted("enc-change");
    const nextFile = join(dir, "next");
    writeFileSync(nextFile, NEXT);
    const recordBefore = readProfileKey(folder) as ProfileKeyRecord;
    error(await ghostly(["--home", dir, "profile", "passphrase", "--passphrase-file", passphraseFile], { env }), "usage", 2);
    const wrong = join(dir, "wrong");
    writeFileSync(wrong, "not the passphrase at all");
    expect(error(await ghostly(["--home", dir, "profile", "passphrase", "--passphrase-file", wrong, "--new-passphrase-file", nextFile], { env }), "refused", 1).message).toBe("Wrong passphrase");
    expect(ok(await ghostly(["--home", dir, "profile", "passphrase", "--passphrase-file", passphraseFile, "--new-passphrase-file", nextFile], { env }))).toEqual({ profile: "default", passphrase: "changed" });
    const after = readProfileKey(folder) as ProfileKeyRecord;
    expect(after.kdf.salt).not.toBe(recordBefore.kdf.salt);
    expect(statSync(join(folder, PROFILE_KEY)).mode & 0o777).toBe(0o600);
    error(await ghostly(["--home", dir, "profile", "show"], { env: { ...env, GHOSTLY_PROFILE_PASSPHRASE: PASSPHRASE } }), "refused", 1);
    ok(await ghostly(["--home", dir, "profile", "show"], { env: { ...env, GHOSTLY_PROFILE_PASSPHRASE: NEXT } }));
    // Nothing the command printed holds either passphrase.
    const all = await ghostly(["--home", dir, "profile", "passphrase", "--passphrase-file", nextFile], { env: { ...env, GHOSTLY_PROFILE_NEW_PASSPHRASE: PASSPHRASE } });
    expect(all.stdout + all.stderr).not.toContain(PASSPHRASE);
    expect(all.stdout + all.stderr).not.toContain(NEXT);
  });

  it("a backup of an encrypted profile is refused before any passphrase is asked for; a profile without the record is as before", async () => {
    const { dir } = await encrypted("enc-backup");
    const refused = error(await ghostly(["--home", dir, "profile", "backup", "--out", join(dir, "b.ghostly"), "--no-passphrase"], { env }), "refused", 1);
    expect(refused.message).toMatch(/encrypted profile/);
    const plain = home("enc-plain");
    dirs.push(plain);
    ok(await ghostly(["--home", plain, "profile", "show"], { env }));
    error(await ghostly(["--home", plain, "profile", "passphrase"], { env }), "refused", 1);
  });
});

describe("the profile passphrase's sources and pace", () => {
  it("comes from the file, then the environment, then a terminal, typed twice when new; else a usage error", async () => {
    const asked: string[] = [];
    const terminal = (answers: string[], isTTY = true) => ({ isTTY, read: async (prompt: string) => { asked.push(prompt); return answers.shift() ?? ""; } });
    const source = { env: "GHOSTLY_TEST_PROFILE_PASSPHRASE", prompt: "Passphrase: ", missing: "none" };
    await expect(readPassphrase(source, terminal([], false))).rejects.toMatchObject({ code: "usage", message: "none" });
    expect(await readPassphrase(source, terminal(["typed"]))).toBe("typed");
    process.env.GHOSTLY_TEST_PROFILE_PASSPHRASE = "from env";
    try { expect(await readPassphrase(source, terminal(["typed"]))).toBe("from env"); } finally { delete process.env.GHOSTLY_TEST_PROFILE_PASSPHRASE; }
    await expect(readPassphrase({ ...source, confirm: true }, terminal(["one", "two"]))).rejects.toMatchObject({ code: "bad_request" });
    expect(await readPassphrase({ ...source, confirm: true }, terminal(["same", "same"]))).toBe("same");
  });

  it("three wrong passphrases are free, then each waits longer, across commands; the right one clears it", async () => {
    const dir = home("enc-pace");
    const wrong = () => tryProfileKey(dir, () => Promise.reject(new Error("Wrong passphrase")));
    for (let i = 0; i < 3; i++) await expect(wrong()).rejects.toMatchObject({ code: "refused", message: "Wrong passphrase" });
    // The fourth try is refused before it runs.
    let ran = false;
    await expect(tryProfileKey(dir, async () => { ran = true; return 1; })).rejects.toMatchObject({ code: "refused", message: expect.stringMatching(/^Wrong passphrase\. Try again in \d+ s$/) });
    expect(ran).toBe(false);
    expect(statSync(join(dir, "profile-key.attempts")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "profile-key.attempts"), JSON.stringify({ failures: 3, retryAt: 0 }));
    expect(await tryProfileKey(dir, async () => 7)).toBe(7);
    expect(existsSync(join(dir, "profile-key.attempts"))).toBe(false);
  });
});
