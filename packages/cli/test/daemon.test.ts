import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { createInterface } from "node:readline";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createProfile, lockOwner, profilePaths } from "../src/profiles";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.daemon, headless.cli

/** A daemon started before an upgrade: commands say so, and `daemon restart` runs the new code. */
let relay: { url: string; server: HttpServer };
let dht: { bootstrap: string; destroy(): Promise<void> };
let env: NodeJS.ProcessEnv;
const dir = home("restart");

beforeAll(async () => {
  relay = await localRelay();
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url };
}, 30_000);

afterAll(async () => {
  await ghostly(["--home", dir, "daemon", "stop"], { env });
  await dht?.destroy();
  relay?.server.close();
}, 30_000);

describe("the daemon's version", { timeout: 120_000 }, () => {
  it("a command warns on stderr when the daemon runs another release, and still answers", async () => {
    const other = home("old-daemon");
    createProfile(other, "default");
    const socket = profilePaths(other, "default").socket;
    const methods: string[] = [];
    const server: Server = createServer((connection) => {
      createInterface({ input: connection }).on("line", (line) => {
        const { id, method } = JSON.parse(line) as { id: number; method: string };
        methods.push(method);
        connection.write(JSON.stringify({ id, result: method === "status" ? { version: "0.0.1", profile: "default" } : { chats: [] } }) + "\n");
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      const listed = await ghostly(["--home", other, "chat", "list"]);
      expect(ok(listed)).toEqual({ chats: [] });
      expect(listed.stderr).toContain(`the daemon runs 0.0.1 and this command is ${packageJson.version}`);
      expect(listed.stderr).toContain("ghostly daemon restart");
      expect(methods).toEqual(["status", "chat.list"]);
    } finally {
      server.close();
      rmSync(socket, { force: true });
    }
  });

  it("daemon restart stops the running one and starts this release; with none running it starts one", async () => {
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    // The socket, running or not: the examples on the socket API are told to take it from here.
    expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toEqual({ running: false, profile: "default", socket: profilePaths(dir, "default").socket });
    const first = ok(await ghostly(["--home", dir, "daemon", "restart"], { env }));
    expect(first).toMatchObject({ restarted: true, stopped: null, before: null, version: packageJson.version, daemon: "started" });
    const second = await ghostly(["--home", dir, "daemon", "restart"], { env });
    expect(ok(second)).toMatchObject({ restarted: true, stopped: first.pid, before: packageJson.version, version: packageJson.version });
    expect(second.json.pid).not.toBe(first.pid);
    const status = await ghostly(["--home", dir, "daemon", "status"], { env });
    expect(ok(status)).toMatchObject({ running: true, pid: second.json.pid, version: packageJson.version, socket: second.json.socket });
    expect(status.stderr).not.toContain("the daemon runs");
    const listed = await ghostly(["--home", dir, "chat", "list"], { env });
    expect(ok(listed)).toEqual({ chats: [] });
    expect(listed.stderr).toBe("");
  });

  it("daemon restart on a daemon that does not answer ends it, SIGTERM then SIGKILL, and starts a fresh one", async () => {
    const wedged = home("wedged-restart");
    ok(await ghostly(["--home", wedged, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const paths = profilePaths(wedged, "default");
    // A daemon whose event loop wedged: its socket accepts and never answers, and it holds the profile; one that
    // ignores SIGTERM, as a loop that runs no handler does. The version probe ahead of the stop gets no answer either.
    const stuck = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:net").createServer(() => {}).listen(process.argv[1], () => process.stdout.write("ready\\n"))', paths.socket], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve) => stuck.stdout!.once("data", () => resolve()));
      writeFileSync(paths.lock, String(stuck.pid));
      const ended = new Promise<string | null>((resolve) => stuck.once("exit", (_, signalName) => resolve(signalName)));
      const restarted = await ghostly(["--home", wedged, "daemon", "restart", "--timeout", "1"], { env });
      expect(ok(restarted)).toMatchObject({ restarted: true, stopped: stuck.pid, before: null, version: packageJson.version, daemon: "started" });
      expect(restarted.json.pid).not.toBe(stuck.pid);
      expect(restarted.stderr).toContain(`process ${stuck.pid}) did not answer daemon.stop in 1 s: stopping it with SIGTERM`);
      expect(restarted.stderr).toContain("did not stop on SIGTERM in 1 s: killing it");
      expect(await ended).toBe("SIGKILL");
      expect(ok(await ghostly(["--home", wedged, "daemon", "status"], { env }))).toMatchObject({ running: true, pid: restarted.json.pid });
    } finally {
      stuck.kill("SIGKILL");
      await ghostly(["--home", wedged, "daemon", "stop"], { env });
    }
  });

  it("daemon status and daemon stop on a profile that does not exist say so; `default` is not made by asking", async () => {
    const typo = home("no-such-profile");
    createProfile(typo, "bot");
    const message = "No profile nobody: make it with `ghostly profile create nobody`";
    expect(error(await ghostly(["--home", typo, "-p", "nobody", "daemon", "status"], { env }), "not_found", 3).message).toBe(message);
    expect(error(await ghostly(["--home", typo, "-p", "nobody", "daemon", "stop"], { env }), "not_found", 3).message).toBe(message);
    expect(existsSync(profilePaths(typo, "nobody").dir)).toBe(false);
    // A profile that exists and `default`, which is made on first use, are only not running.
    expect(ok(await ghostly(["--home", typo, "-p", "bot", "daemon", "status"], { env }))).toMatchObject({ running: false, profile: "bot" });
    expect(ok(await ghostly(["--home", typo, "-p", "default", "daemon", "status"], { env }))).toMatchObject({ running: false, profile: "default" });
    expect(error(await ghostly(["--home", typo, "-p", "default", "daemon", "stop"], { env }), "not_found", 3).message).toBe("No daemon runs profile default");
    expect(existsSync(profilePaths(typo, "default").dir)).toBe(false);
  });

  it("daemon --detach on a profile another process holds says busy and names that process", async () => {
    const held = home("held");
    createProfile(held, "default");
    // This test's own process stands in for a one-shot command that opened the profile in process.
    writeFileSync(profilePaths(held, "default").lock, String(process.pid));
    const started = await ghostly(["--home", held, "daemon", "--detach"], { env });
    expect(error(started, "busy", 1).message).toContain(`in use by process ${process.pid}`);
    expect(started.json.error).toMatchObject({ details: { pid: process.pid } });
  });

  it("daemon --detach with a timeout shorter than the start says the daemon is still starting, with its pid; 0 or less is a usage error", async () => {
    const slow = home("detach-timeout");
    ok(await ghostly(["--home", slow, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    try {
      for (const timeout of ["0", "-1"]) {
        for (const command of [["daemon", "--detach"], ["daemon", "stop"], ["daemon", "restart"]]) {
          expect(error(await ghostly(["--home", slow, ...command, "--timeout", timeout], { env }), "usage", 2).message).toBe("--timeout takes a number of seconds above 0");
        }
      }
      expect(ok(await ghostly(["--home", slow, "daemon", "status"], { env }))).toMatchObject({ running: false });
      const started = await ghostly(["--home", slow, "daemon", "--detach", "--timeout", "0.01"], { env });
      const failure = error(started, "timeout", 4);
      const pid = (started.json.error as { details?: { pid?: number } }).details?.pid;
      expect(pid).toBeTypeOf("number");
      expect(failure.message).toBe(`The daemon (process ${pid}) is still starting; ghostly daemon status shows when it is up`);
      // It was not given up on: it comes up, and it is the one named.
      const until = Date.now() + 60_000;
      let status = ok(await ghostly(["--home", slow, "daemon", "status"], { env }));
      while (!status.running && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = ok(await ghostly(["--home", slow, "daemon", "status"], { env }));
      }
      expect(status).toMatchObject({ running: true, pid });
    } finally {
      // A daemon started in the background is stopped, once it is up (it may still be starting).
      const until = Date.now() + 60_000;
      while (Date.now() < until && !(await ghostly(["--home", slow, "daemon", "status"], { env })).json.running && lockOwner(profilePaths(slow, "default")) !== null) await new Promise((resolve) => setTimeout(resolve, 250));
      await ghostly(["--home", slow, "daemon", "stop"], { env });
    }
  });

  it("a daemon whose terminal closes (SIGHUP) stops cleanly and frees its profile", async () => {
    const hung = home("hangup");
    ok(await ghostly(["--home", hung, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const daemon = new Running(["--home", hung, "daemon"], env);
    try {
      const ready = await daemon.waitFor((l) => l.daemon === "ready");
      daemon.child.kill("SIGHUP");
      expect(await daemon.exited(30_000)).toBe(0);
      expect(existsSync(ready.socket as string)).toBe(false);
      expect(existsSync(profilePaths(hung, "default").lock)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it("a daemon whose output nobody reads any more (the process that started it died) still answers and stops on SIGTERM", async () => {
    // A relay that hangs up on every request: after three the daemon says on stderr that it leaves it alone.
    let asked = 0;
    const dead = createHttpServer((request) => { asked++; request.socket.destroy(); });
    await new Promise<void>((listening) => dead.listen(0, "127.0.0.1", listening));
    const deaf = home("deaf"), deafEnv = { ...env, GHOSTLY_PKARR_RELAYS: `http://127.0.0.1:${(dead.address() as AddressInfo).port}` };
    const daemon = new Running(["--home", deaf, "daemon"], deafEnv);
    try {
      await daemon.waitFor((l) => l.daemon === "ready");
      // The read end of its stderr closes, as when its parent is killed: what it writes there fails from now on.
      daemon.child.stderr!.destroy();
      // An invite to publish: what makes the daemon ask its relay. A daemon that turns in circles answers no command.
      const asks = (...args: string[]) => Promise.race([ghostly(["--home", deaf, ...args], { env: deafEnv }), new Promise<never>((_, late) => setTimeout(() => late(new Error(`no answer to ${args.join(" ")} in 15 s`)), 15_000))]);
      ok(await asks("invite", "create", "--label", "nobody"));
      const until = Date.now() + 30_000;
      while (asked < 3 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(asked).toBeGreaterThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(ok(await asks("status")).mode).toBe("daemon");
      daemon.child.kill("SIGTERM");
      expect(await daemon.exited(10_000)).toBe(0);
    } finally {
      daemon.child.kill("SIGKILL");
      dead.close();
    }
  });

  it("engine clearProfileData asks for --yes, says what it removed, and a daemon stops instead of showing what is gone", async () => {
    const cleared = home("clear-profile");
    ok(await ghostly(["--home", cleared, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    ok(await ghostly(["--home", cleared, "invite", "create", "--label", "bob"], { env }));
    ok(await ghostly(["--home", cleared, "group", "create", "team", "--mesh"], { env }));
    const daemon = new Running(["--home", cleared, "daemon"], env);
    try {
      await daemon.waitFor((l) => l.daemon === "ready");
      expect(error(await ghostly(["--home", cleared, "engine", "clearProfileData"], { env }), "confirm", 5).message).toContain("--yes");
      expect(ok(await ghostly(["--home", cleared, "status"], { env }))).toMatchObject({ mode: "daemon", chats: 1, groups: 1 });
      expect(ok(await ghostly(["--home", cleared, "engine", "clearProfileData", "--yes"], { env }))).toEqual({ cleared: { chats: 1, groups: 1 }, stopped: true });
      expect(await daemon.exited(30_000)).toBe(0);
      // The next command opens the emptied profile itself: nothing the daemon held in memory comes back.
      expect(ok(await ghostly(["--home", cleared, "status"], { env }))).toMatchObject({ mode: "one-shot", chats: 0, groups: 0 });
    } finally {
      await daemon.stop();
    }
  });
});
