import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnv, dropSecretEnv } from "../src/childEnv";
import { main } from "../src/main";
import { streamFfmpeg } from "../src/voicePeaks";
import { home } from "./support/cli";
// covers: headless.daemon, headless.cli

/** What `spawn` was asked to start. A detached daemon is not started (a child that exited at once stands in); anything else runs for real. */
const spawned = vi.hoisted(() => [] as { command: string; args: readonly string[]; options: { detached?: boolean; env?: NodeJS.ProcessEnv } }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...real,
    spawn: (command: string, args: readonly string[], options: { detached?: boolean; env?: NodeJS.ProcessEnv }) => {
      spawned.push({ command, args, options });
      if (!options?.detached) return real.spawn(command, args as string[], options as never);
      return Object.assign(new Emitter(), { exitCode: 1, signalCode: null, pid: undefined, unref() {} });
    },
  };
});

const PASSPHRASE = "correct horse battery staple";

/** No child the CLI starts carries the backup passphrase: only a one-shot `profile backup`/`restore` reads it, in its own process. */
describe("the backup passphrase is never handed to a child process", () => {
  let before: string | undefined;
  beforeEach(() => { before = process.env.GHOSTLY_BACKUP_PASSPHRASE; process.env.GHOSTLY_BACKUP_PASSPHRASE = PASSPHRASE; spawned.length = 0; });
  afterEach(() => { if (before === undefined) delete process.env.GHOSTLY_BACKUP_PASSPHRASE; else process.env.GHOSTLY_BACKUP_PASSPHRASE = before; });

  it("daemon --detach starts the daemon with an environment that lacks it", async () => {
    const dir = home("detach-env");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try { await expect(main(["--home", dir, "daemon", "--detach", "--timeout", "1"])).rejects.toThrow(/did not start/); } finally { write.mockRestore(); }
    const daemon = spawned.find((call) => call.options.detached && call.args.includes("daemon"));
    const env = daemon?.options.env ?? {};
    // Names only: a failure prints no values from the environment.
    expect(Object.keys(env)).not.toContain("GHOSTLY_BACKUP_PASSPHRASE");
    expect(env.GHOSTLY_DAEMON_DETACHED).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
    expect(process.env.GHOSTLY_BACKUP_PASSPHRASE).toBe(PASSPHRASE); // the command's own process keeps it
  });

  it("ffmpeg, started by the daemon to read a voice note, runs without it", async () => {
    const dir = home("ffmpeg-env");
    const ffmpeg = join(dir, "ffmpeg");
    writeFileSync(ffmpeg, "#!/bin/sh\nenv > \"$0.env\"\nexit 1\n");
    chmodSync(ffmpeg, 0o755);
    await expect(streamFfmpeg(join(dir, "voice.ogg"), { start() {}, push: () => true }, ffmpeg)).rejects.toThrow();
    const env = readFileSync(`${ffmpeg}.env`, "utf8"), names = env.split("\n").map((line) => line.split("=")[0]);
    // Names only: a failure prints no values from the environment.
    expect(names).toContain("PATH");
    expect(names).not.toContain("GHOSTLY_BACKUP_PASSPHRASE");
    expect(env.includes(PASSPHRASE)).toBe(false);
  });

  it("childEnv leaves out the secrets and keeps the rest; dropSecretEnv takes them out of an environment itself", () => {
    const env = { PATH: "/bin", GHOSTLY_BACKUP_PASSPHRASE: PASSPHRASE, GHOSTLY_PROFILE: "bot" };
    expect(childEnv(env)).toEqual({ PATH: "/bin", GHOSTLY_PROFILE: "bot" });
    expect(env.GHOSTLY_BACKUP_PASSPHRASE).toBe(PASSPHRASE);
    dropSecretEnv(env);
    expect(env).toEqual({ PATH: "/bin", GHOSTLY_PROFILE: "bot" });
  });
});
