import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// covers: push.wake.send, transport.hyperdht-relay

/**
 * The two relays on SIGTERM (infra/services/*\/server.mjs): a restart ends in a few seconds whatever a client does, and
 * the log says it stopped, so an operator tells a clean stop from a crash. The push relay waited for a client holding
 * a half-sent request for as long as it stayed (Node's request timeout stops with `server.close()`), and the HyperDHT
 * relay cut every WebSocket as a crash would (1006), both with nothing logged.
 */
const SERVICES = resolve(import.meta.dirname, "../../../infra/services");

let child: ChildProcess | undefined;
afterEach(() => { child?.kill("SIGKILL"); child = undefined; });

/** Starts a relay's server.mjs and resolves once it logs that it is on its port. */
async function start(service: string, env: Record<string, string>) {
  const run = spawn(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env: { ...process.env, HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child = run;
  const lines: string[] = [];
  run.stdout.setEncoding("utf8").on("data", (text: string) => lines.push(...text.split("\n").filter(Boolean)));
  run.stderr.resume();
  const exited = new Promise<number | null>((done) => run.once("exit", (code) => done(code)));
  await new Promise<void>((ready, fail) => {
    const check = setInterval(() => { if (lines.some((line) => / on port /.test(line))) { clearInterval(check); ready(); } }, 50);
    void exited.then(() => { clearInterval(check); fail(new Error(`${service} exited: ${lines.join("\n")}`)); });
  });
  return { run, lines, exited };
}

/** How long the process takes to exit after SIGTERM, and its exit code; null past `limitMs`. */
async function stop(run: ChildProcess, exited: Promise<number | null>, limitMs: number) {
  const started = Date.now();
  run.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise<"running">((done) => setTimeout(() => done("running"), limitMs))]);
  return { code, ms: Date.now() - started };
}

describe("the relays on SIGTERM", () => {
  it("the push relay ends in a few seconds while a client holds a half-sent request, and says so", async () => {
    const { run, lines, exited } = await start("push-relay", { PORT: "5540" });
    const socket = connect(5540, "127.0.0.1");
    await new Promise((done) => socket.once("connect", done));
    socket.write("POST / HTTP/1.1\r\nHost: relay\r\nOrigin: https://app.ghostly.tools\r\nContent-Length: 100\r\n\r\n{");
    socket.resume();
    socket.on("error", () => {});
    await new Promise((done) => setTimeout(done, 200));
    const { code, ms } = await stop(run, exited, 8_000);
    socket.destroy();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(6_000);
    expect(lines.some((line) => /Ghostly push relay stopping \(1 client\)$/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/Ghostly push relay stopped$/);
  }, 20_000);

  it("the HyperDHT relay closes each WebSocket as going away (1001), and says so", async () => {
    const { run, lines, exited } = await start("hyperdht-relay", { PORT: "5541", GHOSTLY_HYPERDHT_TESTNET: "3" });
    expect(lines.find((line) => / on port /.test(line))).toMatch(/ Ghostly HyperDHT relay on port 5541 \(own testnet of 3 nodes\) on 127\.0\.0\.1, /);
    const ws = new WebSocket("ws://127.0.0.1:5541");
    await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
    const closed = new Promise<{ code: number; reason: string }>((done) => { ws.onclose = (event) => done({ code: event.code, reason: event.reason }); });
    const { code, ms } = await stop(run, exited, 8_000);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(4_000);
    expect(await closed).toEqual({ code: 1001, reason: "The relay is stopping" });
    expect(lines.some((line) => /Ghostly HyperDHT relay stopping \(1 client\)$/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/Ghostly HyperDHT relay stopped$/);
  }, 30_000);
});
