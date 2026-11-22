import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok } from "./support/cli";
// covers: headless.daemon

/**
 * `daemon --detach` judges its child by the child's own answer in `daemon.log`, which every daemon of the profile
 * writes. Another detach's child that lost the profile writes `busy` there too: the detach took that line for its own
 * child's, and when `daemon stop` ended its child it started a second daemon right after the stop answered "stopped".
 */
describe("daemon --detach reads only its own child's answer", { timeout: 120_000 }, () => {
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
    await Promise.all(dirs.map((dir) => ghostly(["--home", dir, "daemon", "stop"], { env })));
    await dht?.destroy();
    relay?.server.close();
  }, 30_000);

  /**
   * A profile whose detached children (not the detach itself) run `first` ahead of the CLI, the first child only; each
   * child's pid is added to `spawns`. `lock` is the profile's lock in `first`.
   */
  async function lab(name: string, first: string) {
    const dir = home(name);
    dirs.push(dir);
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const paths = profilePaths(dir, "default"), spawns = join(dir, "spawns"), preload = join(dir, "child.cjs");
    writeFileSync(preload, [
      `const fs = require("node:fs"), { spawn, spawnSync } = require("node:child_process"), lock = ${JSON.stringify(paths.lock)};`,
      `if (process.env.GHOSTLY_DAEMON_DETACHED === "1") {`,
      `  const firstChild = !fs.existsSync(${JSON.stringify(spawns)});`,
      `  fs.appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");`,
      `  if (firstChild) { ${first} }`,
      `}`,
    ].join("\n"));
    const pids = () => existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n").map(Number) : [];
    const lockPid = () => { try { return Number(readFileSync(paths.lock, "utf8").trim()); } catch { return null; } };
    return { dir, pids, lockPid, env: { ...env, NODE_OPTIONS: `--require "${preload}"` } };
  }

  it("a child that took the profile and was stopped is not started again for another child's busy line", async () => {
    // The first child stands in for a daemon that took the profile and was ended by `daemon stop` (SIGTERM, exit 0)
    // before its detach saw its socket; ahead of it, another detach's child that lost the profile to it wrote busy into
    // the log. It runs in a process of its own (`spawnSync`, its output into the log), the child exits as it does.
    const daemon = [
      `process.stdout.write(JSON.stringify({ error: { code: "busy", message: "Profile default is in use by process " + process.ppid, details: { pid: process.ppid } } }) + "\\n");`,
      `fs.writeFileSync(lock, String(process.pid));`,
      `process.stdout.write(JSON.stringify({ daemon: "ready", profile: "default", pid: process.pid }) + "\\n");`,
      `process.on("SIGTERM", () => { fs.rmSync(lock, { force: true }); process.exit(0); });`,
      `setInterval(() => {}, 1000);`,
    ].join(" ");
    const { dir, pids, lockPid, env: labEnv } = await lab("detach-stopped", `
      const ran = spawnSync(process.execPath, ["-e", "const fs = require('node:fs'), lock = process.argv[1]; " + ${JSON.stringify(daemon)}, lock], { stdio: "inherit", env: {} });
      process.exit(ran.status ?? 1);
    `);
    const detach = ghostly(["--home", dir, "daemon", "--detach", "--timeout", "20"], { env: labEnv });
    const until = Date.now() + 20_000;
    let stand: number | null;
    while ((stand = lockPid()) === null || pids().length === 0) {
      if (Date.now() > until) throw new Error("the first child never took the profile");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(stand, "SIGTERM");
    // It never saw its daemon up: that daemon did not start, as far as the detach knows; it starts none of its own.
    error(await detach, "engine", 1);
    // A moment for a second child, had one been started, to come up.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(pids()).toHaveLength(1);
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toMatchObject({ running: false });
  });

  it("a child that lost the profile to a one-shot that ended since is started again", async () => {
    // The first child finds the profile held by a one-shot command; the one-shot is gone (its lock with it) by the time
    // the child's answer, busy, is read: only that answer says the child lost, and the detach tries again.
    const { dir, pids, env: labEnv } = await lab("detach-lost", `
      const oneShot = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true, env: {} });
      fs.writeFileSync(lock, String(oneShot.pid));
      process.on("exit", () => { oneShot.kill("SIGKILL"); fs.rmSync(lock, { force: true }); });
    `);
    const started = ok(await ghostly(["--home", dir, "daemon", "--detach", "--timeout", "30"], { env: labEnv }));
    expect(pids()).toHaveLength(2);
    expect(started).toMatchObject({ daemon: "started", pid: pids()[1] });
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toMatchObject({ running: true, pid: pids()[1] });
  });

  it("a child that refused to start answers with its own error, code and exit status", async () => {
    const dir = home("detach-refused");
    dirs.push(dir);
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const log = profilePaths(dir, "default").log;
    // Another child's refusal in the log, written as the detach starts: not this child's answer.
    writeFileSync(log, `${JSON.stringify({ error: { code: "busy", message: "Profile default is in use by process 1", details: { child: 1 } } })}\n`);
    const failed = await ghostly(["--home", dir, "daemon", "--detach", "--timeout", "20"], { env: { ...env, GHOSTLY_PKARR_RELAYS: "notaurl" } });
    expect(error(failed, "usage", 2).message).toBe('GHOSTLY_PKARR_RELAYS takes http:// or https:// URLs, comma-separated, not "notaurl"');
    expect((failed.json.error as { details?: unknown }).details).toEqual({ log });
  });

  it("a restart whose new daemon refused to start answers with its error and says the old one was stopped", async () => {
    const dir = home("restart-refused");
    dirs.push(dir);
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const { pid } = ok(await ghostly(["--home", dir, "daemon", "--detach", "--timeout", "30"], { env })) as { pid: number };
    const failed = await ghostly(["--home", dir, "daemon", "restart", "--timeout", "20"], { env: { ...env, GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:99999" } });
    expect(error(failed, "usage", 2).message).toBe(`GHOSTLY_HYPERDHT_BOOTSTRAP takes host:port nodes, comma-separated, not "127.0.0.1:99999". The daemon (process ${pid}) was stopped: start it again with ghostly daemon --detach`);
    expect((failed.json.error as { details?: unknown }).details).toEqual({ log: profilePaths(dir, "default").log, stopped: pid });
  });
});
