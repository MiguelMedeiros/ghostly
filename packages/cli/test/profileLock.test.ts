import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";
import { acquireLock, createProfile, type ProfilePaths } from "../src/profiles";

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
  it("is taken when free, holds this pid, leaves no other file and is removed on release", () => {
    const paths = profile("free");
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
    expect(readdirSync(paths.dir)).toEqual(["daemon.lock"]);
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
    expect(readdirSync(paths.dir)).toEqual(["daemon.lock"]);
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
