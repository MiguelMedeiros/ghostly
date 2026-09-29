import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createProfile, profilePaths } from "../src/profiles";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.daemon, headless.cli

/** A daemon started before an upgrade: commands say so, and `daemon restart` runs the new code. */
let relay: { url: string; server: HttpServer };
let dht: { bootstrap: string; destroy(): Promise<void> };
let env: NodeJS.ProcessEnv;
const dir = home("restart");

beforeAll(async () => {
  relay = await localRelay();
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
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
    const first = ok(await ghostly(["--home", dir, "daemon", "restart"], { env }));
    expect(first).toMatchObject({ restarted: true, stopped: null, before: null, version: packageJson.version, daemon: "started" });
    const second = await ghostly(["--home", dir, "daemon", "restart"], { env });
    expect(ok(second)).toMatchObject({ restarted: true, stopped: first.pid, before: packageJson.version, version: packageJson.version });
    expect(second.json.pid).not.toBe(first.pid);
    const status = await ghostly(["--home", dir, "daemon", "status"], { env });
    expect(ok(status)).toMatchObject({ running: true, pid: second.json.pid, version: packageJson.version });
    expect(status.stderr).not.toContain("the daemon runs");
    const listed = await ghostly(["--home", dir, "chat", "list"], { env });
    expect(ok(listed)).toEqual({ chats: [] });
    expect(listed.stderr).toBe("");
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
});
