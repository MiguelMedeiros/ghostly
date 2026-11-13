import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { error, ghostly, home, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli

/**
 * Two one-shot commands at once on one profile (a script's `&`, two terminals): the second used to fail at once with
 * `busy`, reads included, and a backgrounded send was lost unless the script checked its exit code. It now waits for
 * the first, which leaves in well under a second; one that does not let go is answered with the next step.
 */
describe("one-shot commands at once on one profile", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof localRelay>>;
  let env: NodeJS.ProcessEnv;
  const dir = home("one-shot-busy");

  beforeAll(async () => {
    relay = await localRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env }));
  });
  afterAll(() => relay?.server.close());

  it("each waits for the one that holds the profile: two sends and the reads beside them all answer, and both texts are kept", async () => {
    const runs = await Promise.all([
      ["send", "bob", "one", "--wait", "none"], ["send", "bob", "two", "--wait", "none"],
      ["chat", "list"], ["chat", "history", "bob"], ["settings", "get"],
    ].map((args) => ghostly(["--home", dir, ...args], { env })));
    for (const run of runs) ok(run);
    const texts = (ok(await ghostly(["--home", dir, "chat", "history", "bob"], { env })).messages as { text: string }[]).map((m) => m.text);
    expect(texts.sort()).toEqual(["one", "two"]);
  });

  it("one held by a process that does not let go is answered busy after the wait, with its pid and the next step", async () => {
    const held = home("one-shot-held");
    ok(await ghostly(["--home", held, "settings", "get"], { env }));
    // This test's own process stands in for a command that keeps the profile open.
    writeFileSync(profilePaths(held, "default").lock, String(process.pid));
    const started = Date.now();
    const run = await ghostly(["--home", held, "chat", "list"], { env });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(error(run, "busy", 1).message).toBe(`Profile default is in use by process ${process.pid}, another ghostly command, and was not free after 5 s: run the commands one after another, or start \`ghostly daemon --detach\` so they can run at once`);
    expect(run.json.error).toMatchObject({ details: { pid: process.pid } });
  });

  it("one behind processes that take the profile in turn waits for each of them, not 5 s in all", async () => {
    const turns = home("one-shot-turns");
    ok(await ghostly(["--home", turns, "settings", "get"], { env }));
    const { lock } = profilePaths(turns, "default");
    // This test's own process, then another one, each hold the profile for 3 s: 6 s in all, past one holder's wait.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    try {
      writeFileSync(lock, String(process.pid));
      const started = Date.now();
      const run = ghostly(["--home", turns, "chat", "list"], { env });
      await new Promise((r) => setTimeout(r, 3_000));
      writeFileSync(lock, String(other.pid));
      await new Promise((r) => setTimeout(r, 3_000));
      rmSync(lock, { force: true });
      // Before: busy, "and was not free after 5 s", while the profile was passing from one process to the next.
      expect(ok(await run)).toEqual({ chats: [] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
    } finally { other.kill(); }
  });

  it.skipIf(process.platform === "win32")("one run while the daemon starts goes through it once its socket answers, not busy after the wait", async () => {
    const starting = home("one-shot-daemon-starting");
    ok(await ghostly(["--home", starting, "settings", "get"], { env }));
    const paths = profilePaths(starting, "default");
    const daemon = new Running(["--home", starting, "daemon"], env);
    try {
      // Stopped in the gap between the lock it took and the socket it listens on, which its engine's start makes.
      const pid = String(daemon.child.pid);
      const until = Date.now() + 30_000;
      while ((() => { try { return readFileSync(paths.lock, "utf8").trim() !== pid; } catch { return true; } })()) {
        if (Date.now() > until) throw new Error(`the daemon never took the profile: ${daemon.stderr}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      daemon.child.kill("SIGSTOP");
      expect(existsSync(paths.socket)).toBe(false);
      const run = ghostly(["--home", starting, "chat", "list"], { env });
      await new Promise((r) => setTimeout(r, 1_500));
      daemon.child.kill("SIGCONT");
      const resumed = Date.now();
      expect(ok(await run)).toEqual({ chats: [] });
      expect(Date.now() - resumed).toBeLessThan(4_000);
    } finally {
      daemon.child.kill("SIGCONT");
      await daemon.stop();
    }
  });

  it("on a terminal it says what it waits for once the wait goes on, and on a pipe nothing", async () => {
    const held = home("one-shot-held-tty");
    ok(await ghostly(["--home", held, "settings", "get"], { env }));
    // stderr taken for a terminal's: the CLI reads `process.stderr.isTTY`, which a test's pipe never is.
    const tty = `${held}/tty-stderr.cjs`;
    writeFileSync(tty, "Object.defineProperty(process.stderr, \"isTTY\", { value: true });\n");
    writeFileSync(profilePaths(held, "default").lock, String(process.pid));
    // Before: nothing at all for the 5 s, then the busy answer.
    const [onTty, onPipe] = await Promise.all([
      ghostly(["--home", held, "chat", "list"], { env: { ...env, NODE_OPTIONS: `--require "${tty}"` } }),
      ghostly(["--home", held, "chat", "list"], { env }),
    ]);
    error(onTty, "busy", 1);
    expect(onTty.stderr).toBe(`ghostly: profile default is in use by process ${process.pid}, another ghostly command: waiting for it to let go (up to 5 s; Ctrl-C stops waiting)\n`);
    error(onPipe, "busy", 1);
    expect(onPipe.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32")("on a terminal, one run while the daemon starts says it waits for that start", async () => {
    const starting = home("one-shot-daemon-starting-tty");
    ok(await ghostly(["--home", starting, "settings", "get"], { env }));
    const tty = `${starting}/tty-stderr.cjs`;
    writeFileSync(tty, "Object.defineProperty(process.stderr, \"isTTY\", { value: true });\n");
    const paths = profilePaths(starting, "default");
    const daemon = new Running(["--home", starting, "daemon"], env);
    try {
      const until = Date.now() + 30_000;
      while (!existsSync(`${paths.dir}/daemon.starting`)) {
        if (Date.now() > until) throw new Error(`the daemon never marked its start: ${daemon.stderr}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      daemon.child.kill("SIGSTOP");
      const run = new Running(["--home", starting, "chat", "list"], { ...env, NODE_OPTIONS: `--require "${tty}"` });
      try {
        // Before: nothing for up to 30 s (a big profile's engine start), then busy.
        const told = Date.now() + 5_000;
        while (!run.stderr.includes("\n") && Date.now() < told) await new Promise((r) => setTimeout(r, 50));
        expect(run.stderr).toBe(`ghostly: profile default's daemon (process ${daemon.child.pid}) is starting: waiting for it (up to 30 s; Ctrl-C stops waiting)\n`);
        daemon.child.kill("SIGCONT");
        expect(await run.exited(15_000)).toBe(0);
        expect(run.lines).toEqual([{ chats: [] }]);
      } finally { await run.stop(); }
    } finally {
      daemon.child.kill("SIGCONT");
      await daemon.stop();
    }
  });

  it.skipIf(process.platform === "win32")("one left by a holder that died, whose pid another process has now, is taken over at once", async () => {
    const left = home("one-shot-left");
    ok(await ghostly(["--home", left, "settings", "get"], { env }));
    // A one-shot stopped with Ctrl-C left its lock and its start; this test's own process has its pid now.
    const paths = profilePaths(left, "default");
    writeFileSync(paths.lock, String(process.pid));
    writeFileSync(`${paths.lock}.${process.pid}.start`, "the dead holder's start");
    const started = Date.now();
    ok(await ghostly(["--home", left, "chat", "list"], { env }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(paths.lock)).toBe(false);
  });
});
