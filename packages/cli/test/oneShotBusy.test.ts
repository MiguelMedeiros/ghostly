import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
