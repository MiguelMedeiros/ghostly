import { rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { greeting, HELLO, newDaemonSecret, proof, removeDaemonSecret } from "../src/daemonProof";
import { createProfile, profilePaths } from "../src/profiles";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, type Result } from "./support/cli";
// covers: headless.daemon, headless.cli

/**
 * A read (`chat list`) already on the daemon's socket when the daemon stops or restarts: it is asked again, through the
 * daemon that answers now or on the profile itself. It failed with exit 4, told to check `ghostly chat history` for a
 * message that was never sent, or with exit 1 "The daemon went away", while a command started a moment later answered.
 */
describe.skipIf(process.platform === "win32")("a read the daemon left unanswered as it stopped", { timeout: 120_000 }, () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  /**
   * A profile whose daemon runs in this process (which holds the profile as a daemon does): it proves itself and answers
   * `status`. `drop(method, connection)`: whether it ends that connection on reading `method` instead of answering it;
   * `stop`: then it stops as a daemon does, its secret, socket and lock gone, so the profile is free for a one-shot;
   * `answers`: and still answers that call on the connection, as a stopping daemon does the calls it already read.
   * `greets`: "stopping" when it stops as it greets the first connection, "secretless" when it never had a secret.
   */
  async function fakeDaemon(name: string, drop: (method: string, connection: number) => boolean, { stop = false, answers = false, greets = "proving" as "proving" | "stopping" | "secretless" } = {}): Promise<{ dir: string; methods: string[] }> {
    const dir = home(name);
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    const secret = newDaemonSecret(paths.dir);
    if (greets === "secretless") removeDaemonSecret(paths.dir);
    writeFileSync(paths.lock, String(process.pid));
    const methods: string[] = [];
    let connections = 0;
    const server: Server = createServer((connection: Socket) => {
      const number = ++connections;
      connection.on("error", () => {});
      if (greets === "stopping" && number === 1) { removeDaemonSecret(paths.dir); rmSync(paths.lock, { force: true }); server.close(); }
      connection.write(JSON.stringify(greeting(secret)) + "\n");
      createInterface({ input: connection }).on("line", (line) => {
        const { id, method, params } = JSON.parse(line) as { id: number | string; method: string; params: { nonce?: string } };
        methods.push(method);
        if (drop(method, number)) {
          if (stop) { removeDaemonSecret(paths.dir); rmSync(paths.lock, { force: true }); server.close(); }
          if (!answers) { connection.destroy(); return; }
        }
        if (method === HELLO) { connection.write(JSON.stringify({ id, result: { proof: proof(secret, "daemon", params.nonce!) } }) + "\n"); return; }
        const result = method === "status" ? { version: packageJson.version } : { chats: [{ id: `from connection ${number}` }] };
        connection.write(JSON.stringify({ id, result }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    cleanups.push(() => { server.close(); rmSync(paths.socket, { force: true }); });
    return { dir, methods };
  }

  it("a chat list the daemon read as it stopped answers from the profile itself, not exit 4 with the chat history hint", async () => {
    const { dir } = await fakeDaemon("read-stopped", (method) => method === "chat.list", { stop: true });
    const listed = await ghostly(["--home", dir, "chat", "list"]);
    // Before: {"code":"timeout","message":"The daemon stopped before it answered chat.list, which may be done: check (`ghostly chat history` …"} exit 4.
    expect(ok(listed)).toEqual({ chats: [] });
  });

  it("a chat list the daemon read as it restarted is answered by the daemon that runs now", async () => {
    const { dir, methods } = await fakeDaemon("read-restarted", (method, connection) => method === "chat.list" && connection === 1);
    expect(ok(await ghostly(["--home", dir, "chat", "list"]))).toEqual({ chats: [{ id: "from connection 2" }] });
    expect(methods.filter((method) => method === "chat.list")).toHaveLength(2);
  });

  it("a chat list whose connection ended before the daemon proved itself is asked again, not exit 1 \"The daemon went away\"", async () => {
    const { dir } = await fakeDaemon("read-before-hello", (method, connection) => method === HELLO && connection === 1);
    expect(ok(await ghostly(["--home", dir, "chat", "list"]))).toEqual({ chats: [{ id: "from connection 2" }] });
  });

  it("a chat list whose daemon removed its secret as it stopped, between its greeting and its hello, answers from the profile, not refused", async () => {
    const { dir } = await fakeDaemon("read-secret-gone", (method) => method === HELLO, { stop: true, answers: true });
    // Before: {"code":"refused", … "did not prove it is this profile's daemon … `ghostly daemon restart` …"} exit 1.
    expect(ok(await ghostly(["--home", dir, "chat", "list"]))).toEqual({ chats: [] });
  });

  it("a chat list whose daemon removed its secret as it stopped, right after it greeted, answers from the profile, not refused", async () => {
    const { dir } = await fakeDaemon("read-greeted-stopping", () => false, { greets: "stopping" });
    // Before: {"code":"refused", … "did not prove it is this profile's daemon … `ghostly daemon restart` …"} exit 1.
    expect(ok(await ghostly(["--home", dir, "chat", "list"]))).toEqual({ chats: [] });
  });

  it("a listener that never proves itself is still refused for a read, once asked again, and is sent nothing", async () => {
    const { dir, methods } = await fakeDaemon("read-secretless", () => false, { greets: "secretless" });
    const failure = error(await ghostly(["--home", dir, "chat", "list"]), "refused", 1);
    expect(failure.message).toContain("did not prove it is this profile's daemon");
    expect(methods).toEqual([]);
  });

  it("a read that goes unanswered again says so with one code and a read's words: no chat history to check", async () => {
    const { dir, methods } = await fakeDaemon("read-twice", (method) => method === "chat.list");
    const failure = error(await ghostly(["--home", dir, "chat", "list"]), "unavailable", 1);
    expect(failure.message).toBe("The daemon went away before it answered chat.list, twice; a read changes nothing: run it again");
    expect(failure.message).not.toContain("chat history");
    // Asked twice, not for ever.
    expect(methods.filter((method) => method === "chat.list")).toHaveLength(2);
  });

  it("a change the daemon read as it stopped is not sent again: it may be done, so it still says to check", async () => {
    const { dir, methods } = await fakeDaemon("write-stopped", (method) => method === "settings.set", { stop: true });
    const failure = error(await ghostly(["--home", dir, "settings", "set", "nick", "bob"]), "timeout", 4);
    expect(failure.message).toContain("The daemon stopped before it answered settings.set, which may be done");
    expect(methods.filter((method) => method === "settings.set")).toHaveLength(1);
  });

  describe("with a real daemon", () => {
    let relay: { url: string; server: HttpServer };
    let dht: { bootstrap: string; destroy(): Promise<void> };
    let env: NodeJS.ProcessEnv;
    beforeAll(async () => {
      relay = await localRelay();
      dht = await hyperdhtTestnet();
      env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url };
    }, 30_000);
    afterAll(async () => { await dht?.destroy(); relay?.server.close(); }, 30_000);

    /** `chat list`s started with `daemon <sub>`, `at` ms after it: each answers (exit 0), as one started later does. */
    async function race(dir: string, sub: "stop" | "restart", at: number[]): Promise<Result[]> {
      const stopping = ghostly(["--home", dir, "daemon", sub], { env });
      const reads = at.map((ms) => new Promise<Result>((resolve) => setTimeout(() => resolve(ghostly(["--home", dir, "chat", "list"], { env })), ms)));
      ok(await stopping);
      return Promise.all(reads);
    }

    it("chat lists started with daemon stop and daemon restart all answer", async () => {
      const dir = home("read-race");
      ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
      try {
        for (const sub of ["stop", "restart"] as const) {
          for (let round = 0; round < 3; round++) {
            ok(await ghostly(["--home", dir, "daemon", "--detach"], { env }));
            for (const read of await race(dir, sub, [0, 0, 0, 0, 50, 150])) expect(ok(read)).toEqual({ chats: [] });
            if (sub === "restart") ok(await ghostly(["--home", dir, "daemon", "stop"], { env }));
          }
        }
      } finally { await ghostly(["--home", dir, "daemon", "stop"], { env }); }
    }, 300_000);
  });
});
