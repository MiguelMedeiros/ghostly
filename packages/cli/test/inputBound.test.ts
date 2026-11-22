import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { greeting, HELLO, newDaemonSecret, proof } from "../src/daemonProof";
import { CliError } from "../src/errors";
import { createProfile, profilePaths } from "../src/profiles";
import { ghostly, home } from "./support/cli";
// covers: headless.cli, headless.daemon

const MOST = 16 * 1024 * 1024;
const STDIN = { error: { code: "bad_request", message: "More than 16 MiB came on stdin, more than any command takes (a long text goes as a file: ghostly file send <chat|group> <path>)" } };
const file = (path: string) => ({ error: { code: "bad_request", message: `${path} holds more than 16 MiB, more than any command takes (a file to share goes as one: ghostly file send <chat|group> <path>)` } });

/**
 * What a command reads whole from stdin or a file named on its line, and the request line it writes to a daemon: at
 * most 16 MiB, the longest line a daemon reads. `app send … -` and a card's `--json -` read stdin with no bound (600
 * MiB answered V8's "Cannot create a string longer than 0x1fffffe8 characters"), files were read whole, and a line
 * past 16 MiB reached a daemon that cut the connection: "The daemon went away" (unavailable, read as try later).
 */
describe("input past a daemon's request line", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  it("stdin to app send - and to a card's --json - is refused past 16 MiB before the profile opens", { timeout: 60_000 }, async () => {
    const dir = home("input-stdin");
    for (const args of [["app", "send", "bob", "chess", "-"], ["task", "send", "bob", "--json", "-"], ["routine", "update", "bob", "r1", "--json", "-"]]) {
      const result = await ghostly(["--home", dir, ...args], { input: "a".repeat(MOST + 1) });
      expect(result.json, args.join(" ")).toEqual(STDIN);
      expect(result.code, args.join(" ")).toBe(1);
    }
    // 16 MiB itself is read: what answers is the command's own check.
    expect((await ghostly(["--home", dir, "task", "send", "bob", "--json", "-"], { input: "a".repeat(MOST) })).json).toEqual({ error: { code: "usage", message: "--json is not valid JSON" } });
  });

  it("a file a request carries (--json, --evidence-file, x401 credential add) is refused past 16 MiB, named", { timeout: 60_000 }, async () => {
    const dir = home("input-file");
    const big = join(dir, "big.json");
    writeFileSync(big, "a".repeat(MOST + 1));
    for (const args of [["task", "send", "bob", "--json", big], ["identity", "complete", "d1", "--evidence-file", big], ["x401", "credential", "add", big]]) {
      const result = await ghostly(["--home", dir, ...args]);
      expect(result.json, args.join(" ")).toEqual(file(big));
      expect(result.code, args.join(" ")).toBe(1);
    }
    writeFileSync(big, "a".repeat(MOST));
    expect((await ghostly(["--home", dir, "task", "send", "bob", "--json", big])).json).toEqual({ error: { code: "usage", message: "--json is not valid JSON" } });
  });

  it("a request line past the daemon's limit is refused before it is written, and the connection goes on", async () => {
    const dir = home("input-line");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    const secret = newDaemonSecret(paths.dir);
    writeFileSync(paths.lock, String(process.pid));
    const methods: string[] = [];
    // Proves itself, answers every call, and cuts a line past 16 MiB as host.ts does (`MAX_LINE`).
    const server: Server = createServer((connection) => {
      connection.on("error", () => {});
      connection.write(JSON.stringify(greeting(secret)) + "\n");
      let buffered = 0;
      createInterface({ input: connection, crlfDelay: Infinity }).on("line", (line) => {
        buffered = 0;
        const { id, method, params } = JSON.parse(line) as { id: string; method: string; params: { nonce?: string } };
        methods.push(method);
        connection.write(JSON.stringify(method === HELLO ? { id, result: { proof: proof(secret, "daemon", params.nonce!) } } : { id, result: { ok: true } }) + "\n");
      }).on("error", () => {});
      connection.on("data", (chunk) => { buffered += chunk.length; if (buffered > MOST) connection.destroy(); });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    cleanups.push(() => { server.close(); rmSync(paths.socket, { force: true }); });
    const client = (await connectDaemon(paths))!;
    cleanups.push(() => client.destroy());
    // 9 MiB of line breaks under 16 MiB of stdin's bound: JSON writes each as two bytes, 18 MiB.
    const failure = await client.call("chat.send", { chat: "bob", text: "\n".repeat(9 * 1024 * 1024) }).catch((error: unknown) => error) as CliError;
    expect(failure).toBeInstanceOf(CliError);
    expect(failure.code).toBe("bad_request");
    expect(failure.message).toBe("chat.send came to 18.0 MiB as JSON, more than a daemon reads in one request (16 MiB): nothing was sent (a long text goes as a file: ghostly file send <chat|group> <path>)");
    expect(await client.call("status")).toEqual({ ok: true });
    expect(methods).toEqual([HELLO, "status"]);
  });
});
