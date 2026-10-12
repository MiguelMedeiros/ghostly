import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { home, Running } from "./support/cli";

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
