import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";
import { acquireLock, claimForDaemon, claimPath, createProfile, processStart, type ProfilePaths } from "../src/profiles";

// covers: headless.cli

/** Runs once, inside `acquireLock`'s first read of the lock: another process acting between its check and its move. */
let onRead: ((path: string) => void) | undefined;
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const hook = onRead;
    if (hook && typeof path === "string" && path.endsWith("daemon.lock")) { onRead = undefined; hook(path); }
    return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const root = mkdtempSync("/tmp/gh-lock-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function profile(name: string): ProfilePaths {
  return createProfile(root, name);
}

/** The pid of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function busy(paths: ProfilePaths): CliError {
  try { acquireLock(paths); } catch (error) { return error as CliError; }
  throw new Error("the lock was taken");
}

/** One process per profile (agents#1642): the lock is never taken from a process that holds it or is making it. */
describe("the profile lock", () => {
  it("is taken when free, holds this pid and its start, leaves no other file and is removed on release", () => {
    const paths = profile("free");
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    expect(readdirSync(paths.dir)).toEqual(withStart(process.pid));
    expect(readFileSync(`${paths.lock}.${process.pid}.start`, "utf8")).toBe(processStart(process.pid));
    expect(busy(paths)).toMatchObject({ code: "busy", details: { pid: process.pid } });
    release();
    expect(readdirSync(paths.dir)).toEqual([]);
  });

  it("an empty lock just made is another process's being written: busy, and the lock is left as it was", () => {
    const paths = profile("empty-young");
    writeFileSync(paths.lock, "");
    expect(busy(paths)).toMatchObject({ code: "busy", message: "Profile empty-young is in use" });
    expect(readFileSync(paths.lock, "utf8")).toBe("");
    expect(readdirSync(paths.dir)).toEqual(["daemon.lock"]);
  });

  it("an empty lock older than a second is a crashed writer's: taken over", () => {
    const paths = profile("empty-old");
    writeFileSync(paths.lock, "");
    const past = new Date(Date.now() - 5_000);
    utimesSync(paths.lock, past, past);
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    release();
  });

  it("a lock whose process is gone is taken over", async () => {
    const paths = profile("stale");
    writeFileSync(paths.lock, String(await deadPid()));
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    expect(readdirSync(paths.dir)).toEqual(withStart(process.pid));
    release();
  });

  it("a stale lock another process replaced with its own after the check is not removed: busy", async () => {
    const paths = profile("replaced");
    writeFileSync(paths.lock, String(await deadPid()));
    // Between this process's look at the lock and its read, the stale lock went and a live process made its own.
    onRead = (lock) => { rmSync(lock); writeFileSync(lock, String(process.ppid)); throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
    expect(busy(paths)).toMatchObject({ code: "busy", details: { pid: process.ppid } });
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.ppid));
    expect(readdirSync(paths.dir)).toEqual(["daemon.lock"]);
  });

  it("a release does not remove a lock another process holds now", () => {
    const paths = profile("release");
    const release = acquireLock(paths);
    writeFileSync(paths.lock, String(process.ppid));
    release();
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.ppid));
  });
});

/**
 * A holder that died without releasing the lock (kill -9, Ctrl-C of a one-shot, a reboot) left its pid; once another
 * process has that pid the profile was held for good: every command, the daemon and `restart` busy.
 */
describe.skipIf(process.platform === "win32")("a lock whose pid is another process's now", () => {
  const sleepers: ChildProcess[] = [];
  afterAll(() => { for (const child of sleepers) child.kill("SIGKILL"); });

  /** A live process that is not the lock's holder: the pid reused. */
  async function liveOther(): Promise<number> {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    sleepers.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    return child.pid!;
  }

  it("is taken over when that process started at another time than the holder", async () => {
    const paths = profile("reused");
    const pid = await liveOther();
    writeFileSync(paths.lock, String(pid));
    // The dead holder's start, beside its lock.
    writeFileSync(`${paths.lock}.${pid}.start`, "the dead holder's start");
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    expect(readdirSync(paths.dir)).toEqual(withStart(process.pid));
    release();
  });

  it("is taken over when it is this process's pid and this process does not hold it", () => {
    const paths = profile("mine-now");
    // A daemon that ran as pid 1 of a container, restarted: the new one is pid 1 too.
    writeFileSync(paths.lock, String(process.pid));
    writeFileSync(`${paths.lock}.${process.pid}.start`, "the dead holder's start");
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    release();
    expect(readdirSync(paths.dir)).toEqual([]);
  });

  it("is busy while that process is the holder: its start is the one beside the lock", async () => {
    const paths = profile("holder");
    const pid = await liveOther();
    writeFileSync(paths.lock, String(pid));
    writeFileSync(`${paths.lock}.${pid}.start`, processStart(pid)!);
    expect(busy(paths)).toMatchObject({ code: "busy", details: { pid } });
    expect(readdirSync(paths.dir).sort()).toEqual(["daemon.lock", `daemon.lock.${pid}.start`]);
  });

  it("an older release's lock, with no start beside it, is busy while its pid is alive, as before", async () => {
    const paths = profile("older");
    const pid = await liveOther();
    writeFileSync(paths.lock, String(pid));
    expect(busy(paths)).toMatchObject({ code: "busy", details: { pid } });
    expect(readdirSync(paths.dir)).toEqual(["daemon.lock"]);
  });
});

/**
 * `daemon restart` and `daemon --detach` keep the profile for the daemon they start, from before the stop until that
 * daemon holds it: one-shot commands taking the free lock in turn kept the new daemon from ever starting.
 */
describe.skipIf(process.platform === "win32")("a profile kept for the daemon a start brings up", () => {
  const sleepers: ChildProcess[] = [];
  afterAll(() => { for (const child of sleepers) child.kill("SIGKILL"); });

  /** A live process: the `daemon restart` that claims the profile. */
  async function claimant(): Promise<number> {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    sleepers.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    return child.pid!;
  }

  it("is busy for any other process while the claimant lives, and names it", async () => {
    const paths = profile("claimed");
    const pid = await claimant();
    writeFileSync(claimPath(paths.dir), String(pid));
    const failure = busy(paths);
    expect(failure).toMatchObject({ code: "busy", details: { pid } });
    expect(failure.message).toBe(`Profile claimed is kept for the daemon that process ${pid} starts`);
    expect(readdirSync(paths.dir)).toEqual(["daemon.claim"]);
  });

  it("is taken by the claimant and by the daemon it spawns (a child of the claimant)", () => {
    for (const [name, pid] of [["claim-own", process.pid], ["claim-parent", process.ppid]] as const) {
      const paths = profile(name);
      writeFileSync(claimPath(paths.dir), String(pid));
      const release = acquireLock(paths);
      expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
      release();
    }
  });

  it("a claim whose process is gone, or not touched for over 10 s, is none", async () => {
    const gone = profile("claim-gone");
    writeFileSync(claimPath(gone.dir), String(await deadPid()));
    acquireLock(gone)();
    const old = profile("claim-old");
    writeFileSync(claimPath(old.dir), String(await claimant()));
    const then = new Date(Date.now() - 11_000);
    utimesSync(claimPath(old.dir), then, then);
    acquireLock(old)();
  });

  it("claimForDaemon writes this pid and removes it on release; another live claim stands", async () => {
    const paths = profile("claim-write");
    const release = claimForDaemon(paths);
    expect(readFileSync(claimPath(paths.dir), "utf8")).toBe(String(process.pid));
    release();
    expect(readdirSync(paths.dir)).toEqual([]);
    const other = await claimant();
    writeFileSync(claimPath(paths.dir), String(other));
    claimForDaemon(paths)();
    expect(readFileSync(claimPath(paths.dir), "utf8")).toBe(String(other));
  });
});

/** The profile's folder with the lock of `pid` and its start (none where the start cannot be read). */
function withStart(pid: number): string[] {
  return processStart(pid) === null ? ["daemon.lock"] : ["daemon.lock", `daemon.lock.${pid}.start`];
}
