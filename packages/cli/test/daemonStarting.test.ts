import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profilePaths, startingPath } from "../src/profiles";
import { ghostly, home, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli

/**
 * A daemon takes the profile's lock, starts its engine, and only then listens on its socket: seconds on a large
 * profile. A command run in that gap found the lock taken and no socket, and took the daemon for another command.
 * Each test stops a foreground daemon (SIGSTOP) the moment the lock holds its pid, runs the command, and resumes it.
 */
describe.skipIf(process.platform === "win32")("a command run while the profile's daemon is starting", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof localRelay>>;
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];

  beforeAll(async () => {
    relay = await localRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
  });
  afterAll(async () => {
    for (const r of running) { r.child.kill("SIGCONT"); await r.stop(); }
    relay?.server.close();
  });

  /** A profile whose foreground daemon is stopped between the lock it took (and its start mark) and the socket it listens on. */
  async function daemonStopped(name: string) {
    const dir = home(name);
    ok(await ghostly(["--home", dir, "settings", "get"], { env }));
    const paths = profilePaths(dir, "default");
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    const pid = String(daemon.child.pid);
    const until = Date.now() + 30_000;
    const holds = (file: string) => { try { return readFileSync(file, "utf8").trim() === pid; } catch { return false; } };
    // The lock, then the start mark the daemon writes right after it: a stop between the two is a daemon not marked yet.
    while (!holds(paths.lock) || !holds(startingPath(paths.dir))) {
      if (Date.now() > until) throw new Error(`the daemon never took the profile: ${daemon.stderr}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    daemon.child.kill("SIGSTOP");
    expect(existsSync(paths.socket)).toBe(false);
    return { dir, paths, daemon, resume: () => daemon.child.kill("SIGCONT") };
  }

  it("listen waits for it and follows it once its socket answers, instead of failing busy at once", async () => {
    const { dir, daemon, resume } = await daemonStopped("listen-daemon-starting");
    const listen = new Running(["--home", dir, "listen", "--since", "0"], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(listen.child.exitCode).toBeNull();
    resume();
    // The daemon's own start, replayed from its journal through its socket.
    await listen.waitFor((line) => line.type === "daemon.started" && (line as { pid?: number }).pid === daemon.child.pid, 10_000);
    expect(listen.child.exitCode).toBeNull();
  });

  it("daemon status says it is starting, with its pid, and running once its socket answers", async () => {
    const { dir, paths, daemon, resume } = await daemonStopped("status-daemon-starting");
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toMatchObject({ running: false, starting: true, pid: daemon.child.pid });
    resume();
    await daemon.waitFor((line) => line.daemon === "ready", 30_000);
    expect(existsSync(startingPath(paths.dir))).toBe(false);
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toMatchObject({ running: true, pid: daemon.child.pid });
  });

  it("a profile a one-shot holds, or with the mark of a daemon that died, is not a daemon starting", async () => {
    const dir = home("status-not-starting");
    ok(await ghostly(["--home", dir, "settings", "get"], { env }));
    const paths = profilePaths(dir, "default");
    // This test's own process stands in for a one-shot that holds the profile; the mark names a pid that is gone.
    writeFileSync(paths.lock, String(process.pid));
    writeFileSync(startingPath(paths.dir), "999999999");
    const status = ok(await ghostly(["--home", dir, "daemon", "status"], { env }));
    expect(status).toMatchObject({ running: false });
    expect(status).not.toHaveProperty("starting");
  });
});
