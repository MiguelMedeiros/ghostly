import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// covers: push.wake.send, transport.hyperdht-relay

/**
 * The two relays when their log can't be written (infra/services/*\/server.mjs): a log pipe whose reader is gone (EPIPE)
 * or a log file that can't grow (EFBIG, as on a full disk) loses the lines, not the relay. The write's error had no
 * listener, so the next line ended the process for every client, and anyone's refused request writes one.
 */
const SERVICES = resolve(import.meta.dirname, "../../../infra/services");
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

let child: ChildProcess | undefined;
let folder: string | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

type Relay = { run: ChildProcess; stdout: string[]; stderr: string[]; exited: Promise<number | null> };

/** Runs `command` in a relay's folder; stdout and stderr are piped to the test unless `command` redirects them. */
function spawnRelay(service: string, command: string[], env: Record<string, string>): Relay {
  const run = spawn(command[0], command.slice(1), { cwd: resolve(SERVICES, service), env: { ...process.env, HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child = run;
  const stdout: string[] = [];
  const stderr: string[] = [];
  run.stdout.setEncoding("utf8").on("data", (text: string) => stdout.push(...text.split("\n").filter(Boolean)));
  run.stderr.setEncoding("utf8").on("data", (text: string) => stderr.push(...text.split("\n").filter(Boolean)));
  run.stdout.on("error", () => {});
  const exited = new Promise<number | null>((done) => run.once("exit", (code) => done(code)));
  return { run, stdout, stderr, exited };
}

/** The status line's code of a raw HTTP request on `port`, or "none" when the connection ends without an answer. */
function ask(port: number, request: string) {
  return new Promise<string>((done) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (status) { done(status[1]); socket.destroy(); }
    });
    socket.on("error", () => done("none"));
    socket.on("close", () => done("none"));
    socket.setTimeout(3000, () => { done("none"); socket.destroy(); });
    socket.write(request);
  });
}

const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n`;
const upgrade = (origin: string) => `GET / HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${origin}\r\n\r\n`;

/** Resolves once `ready` holds, fails if the process exits first or `ms` pass. */
async function until(relay: Relay, ready: () => boolean | Promise<boolean>, ms: number) {
  let gone = false;
  void relay.exited.then(() => { gone = true; });
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    if (gone) throw new Error(`exited: ${relay.stderr.join("\n")}`);
    if (await ready()) return;
  }
  throw new Error("not ready in time");
}

/** Whether the process is still running after `ms`. */
const running = (relay: Relay, ms: number) => Promise.race([relay.exited.then(() => false), wait(ms).then(() => true)]);

const post = (origin: string, body: string) => `POST / HTTP/1.1\r\nHost: relay\r\nConnection: close\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

/**
 * Refusals the relay logs at once, each its own line (a kind is logged once a minute, a refused origin once per value):
 * Node's console lets the first failed write pass, so a relay ended on the second.
 */
const RELAYS: { service: string; name: string; env: Record<string, string>; refusals: [string, string][]; timeoutMs: number }[] = [
  { service: "push-relay", name: "push relay", env: { GHOSTLY_RELAY_ORIGINS: "https://app.example" }, refusals: [[get("/"), "405"], [post("https://other.example", "{}"), "403"], [post("https://app.example", "{}"), "400"]], timeoutMs: 20_000 },
  { service: "hyperdht-relay", name: "HyperDHT relay", env: { GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_RELAY_ORIGINS: "https://app.example" }, refusals: [1, 2, 3].map((n) => [upgrade(`https://other${n}.example`), "403"]), timeoutMs: 40_000 },
];

describe("the relays when their log can't be written", () => {
  RELAYS.forEach(({ service, name, env, refusals, timeoutMs }, index) => {
    it(`the ${name} keeps answering after its log pipe's reader is gone (EPIPE), and says so once on stderr`, async () => {
      const port = 5542 + 2 * index;
      const relay = spawnRelay(service, [process.execPath, "server.mjs"], { ...env, PORT: String(port) });
      await until(relay, () => relay.stdout.some((line) => / on port /.test(line)), timeoutMs - 5000);
      relay.run.stdout!.destroy();
      await wait(100);
      for (const [request, status] of refusals) {
        expect(await ask(port, request)).toBe(status);
        await wait(100);
      }
      expect(await running(relay, 500)).toBe(true);
      expect(await ask(port, get("/healthz"))).toMatch(/^\d{3}$/);
      expect(await ask(port, refusals[0][0])).toBe(refusals[0][1]);
      expect(relay.stderr.filter((line) => /log can't be written \(EPIPE\)/.test(line))).toHaveLength(1);
    }, timeoutMs);

    it(`the ${name} keeps answering when its log file can't grow (EFBIG), and says so once on stderr`, async () => {
      const port = 5543 + 2 * index;
      folder = mkdtempSync(join(tmpdir(), "relay-log-"));
      const file = join(folder, "relay.log");
      // Past the 1-block limit set below: every write to it fails with EFBIG, as on a full disk.
      writeFileSync(file, "x".repeat(4096));
      // Node ignores SIGXFSZ, so the write fails with EFBIG instead of the signal ending it.
      const relay = spawnRelay(service, ["/bin/sh", "-c", "trap '' XFSZ; ulimit -f 1 && exec \"$0\" server.mjs >> \"$1\"", process.execPath, file], { ...env, PORT: String(port) });
      await until(relay, async () => (await ask(port, get("/healthz"))) !== "none", timeoutMs - 5000);
      for (const [request, status] of refusals) {
        expect(await ask(port, request)).toBe(status);
        await wait(100);
      }
      expect(await running(relay, 500)).toBe(true);
      expect(await ask(port, refusals[0][0])).toBe(refusals[0][1]);
      expect(relay.stderr.filter((line) => /log can't be written \(EFBIG\)/.test(line))).toHaveLength(1);
    }, timeoutMs);
  });
});
