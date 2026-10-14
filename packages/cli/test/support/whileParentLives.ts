import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * A long-running process of a test (a daemon, a `listen`) that ends with the process that started it: see
 * ./runWhileParentLives.mjs. Its stdout and stderr are pipes, as with `spawn`; its stdin is the pipe that keeps it alive.
 * No Vitest here: Playwright imports it too (e2e/support/headless.ts).
 */
export function spawnWhileParentLives(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [join(import.meta.dirname, "runWhileParentLives.mjs"), command, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Kills it, whatever it is doing: for one that did not stop on SIGTERM. */
export function endNow(child: ChildProcess): void {
  child.stdin?.end();
}
