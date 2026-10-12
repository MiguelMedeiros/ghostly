import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { home, Running } from "./support/cli";
import { endNow, spawnWhileParentLives } from "./support/whileParentLives";

/**
 * The tests' own `Running`: a process a test stops itself is stopped again by its file's `afterAll`, with every other
 * it started. One that a signal ended has no exit code, only the signal's name.
 */
describe("a long-running process of a test", () => {
  // No handler for SIGTERM: as `listen` in the moment between its first replayed event and its handlers.
  const idle = () => {
    const script = join(home("running"), "idle.mjs");
    writeFileSync(script, "console.log(JSON.stringify({ up: true }));\nsetInterval(() => {}, 1000);\n");
    return new Running([], {}, script);
  };
  const within = <T>(ms: number, work: Promise<T>) => Promise.race([work, new Promise<string>((r) => setTimeout(() => r(`not in ${ms} ms`), ms))]);

  it("one that a signal ended is stopped: a second stop answers at once", async () => {
    const run = idle();
    await run.waitFor((l) => l.up === true);
    expect(await run.stop()).toBeNull();
    expect(run.child.signalCode).toBe("SIGTERM");
    expect(await within(2_000, run.stop())).toBeNull();
  });

  it("one that a signal ended has exited, and a wait for a line of it says so instead of waiting", async () => {
    const run = idle();
    await run.waitFor((l) => l.up === true);
    await run.stop();
    expect(await within(2_000, run.exited(1_000).catch((error: Error) => error.message))).toBeNull();
    expect(await within(2_000, run.waitFor((l) => l.never === true, 60_000).catch((error: Error) => error.message))).toMatch(/^ended by SIGTERM/);
  });
});

/**
 * A test's daemon must not outlive the runner's worker that started it (two e2e bots ran for hours after their
 * worker was killed on a timeout): ./support/whileParentLives.
 */
describe("a process started to live as long as its parent", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = async (pid: number, ms = 5_000) => {
    for (const until = Date.now() + ms; Date.now() < until;) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); }
    return false;
  };
  /** Every process a test here started, by pid: none is left behind by one that fails. */
  const started: number[] = [];
  afterEach(() => { for (const pid of started.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* gone, as it should be */ } });
  const firstLine = (child: { stdout: NodeJS.ReadableStream | null }) => new Promise<number>((line) => child.stdout!.once("data", (d) => {
    const { pid } = JSON.parse(String(d)) as { pid: number };
    started.push(pid);
    line(pid);
  }));
  /** Says its pid, then stays; `deaf`: SIGTERM does not stop it. */
  const stays = (deaf = false) => {
    const script = join(home("stays"), "stays.mjs");
    writeFileSync(script, `${deaf ? 'process.on("SIGTERM", () => {});' : 'process.on("SIGTERM", () => process.exit(7));'}\nconsole.log(JSON.stringify({ pid: process.pid }));\nsetInterval(() => {}, 1000);\n`);
    return script;
  };

  it("is gone once its parent is killed, with no chance to stop it", async () => {
    // The parent: a process of its own (as a runner's worker), which starts the one that stays and passes its line on.
    const parentScript = join(home("parent"), "parent.mjs");
    writeFileSync(parentScript, `import { spawn } from "node:child_process";\nspawn(process.execPath, ${JSON.stringify([join(import.meta.dirname, "support/runWhileParentLives.mjs"), process.execPath, stays(true)])}, { stdio: ["pipe", "inherit", "inherit"] });\n`);
    const parent = spawn(process.execPath, [parentScript], { stdio: ["ignore", "pipe", "inherit"] });
    started.push(parent.pid!);
    const pid = await firstLine(parent);
    expect(alive(pid)).toBe(true);
    parent.kill("SIGKILL");
    expect(await gone(pid)).toBe(true);
  });

  it("stops on SIGTERM with its own exit code, and one that does not is ended at once", async () => {
    const polite = spawnWhileParentLives(process.execPath, [stays()], process.env);
    started.push(polite.pid!);
    await firstLine(polite);
    polite.kill("SIGTERM");
    expect(await new Promise((code) => polite.once("exit", code))).toBe(7);

    const deaf = spawnWhileParentLives(process.execPath, [stays(true)], process.env);
    started.push(deaf.pid!);
    const pid = await firstLine(deaf);
    deaf.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(true);
    endNow(deaf);
    expect(await gone(pid)).toBe(true);
    expect(await new Promise((code) => (deaf.exitCode !== null ? code(deaf.exitCode) : deaf.once("exit", code)))).toBe(1);
  });
});
