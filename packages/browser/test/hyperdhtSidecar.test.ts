import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, copyFileSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, expect, it, vi } from "vitest";
// covers: transport.native-pool

// The desktop's HyperDHT sidecar, as the app runs it, over endpoints held in
// memory instead of the DHT: one process for every endpoint, gone with its parent.
const source = resolve(__dirname, "../../../native-transports/hyperdht");
const folder = mkdtempSync(join(tmpdir(), "ghostly-sidecar-"));
copyFileSync(join(source, "sidecar.mjs"), join(folder, "sidecar.mjs"));
copyFileSync(join(source, "test/fake-endpoint.mjs"), join(folder, "endpoint.mjs"));
const script = join(folder, "sidecar.mjs");
const seed = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

const started: ChildProcess[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type Event = Record<string, unknown>;
function sidecar(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
  started.push(child);
  const events: Event[] = [];
  createInterface({ input: child.stdout! }).on("line", line => events.push(JSON.parse(line)));
  const exited = new Promise<number | null>(done => child.on("exit", code => done(code)));
  return {
    child, events, exited,
    send: (value: object) => child.stdin!.write(JSON.stringify(value) + "\n"),
    next: (match: Partial<Event>) => vi.waitFor(() => {
      const event = events.find(e => Object.entries(match).every(([k, v]) => e[k] === v));
      if (!event) throw new Error(`no ${JSON.stringify(match)} in ${JSON.stringify(events)}`);
      return event;
    }, { timeout: 5000 }),
  };
}

it("hosts every endpoint, each under its own number, in one process", async () => {
  const runtime = sidecar();
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  runtime.send({ type: "start", endpoint: 2, seedB64: seed(2) });
  const b = await runtime.next({ type: "started", endpoint: 2 });
  await runtime.next({ type: "started", endpoint: 1 });

  runtime.send({ type: "connect", endpoint: 1, descriptor: b.descriptor });
  const result = await runtime.next({ type: "result", endpoint: 1 });
  const incoming = await runtime.next({ type: "open", endpoint: 2, incoming: true });
  runtime.send({ type: "send", endpoint: 1, id: result.id, text: "hello" });
  expect(await runtime.next({ type: "frame", endpoint: 2 })).toMatchObject({ id: incoming.id, text: "hello" });

  // A failed command is that endpoint's, and says which command it was.
  runtime.send({ type: "connect", endpoint: 2, descriptor: { publicKey: "00".repeat(32) } });
  expect(await runtime.next({ type: "error", endpoint: 2 })).toMatchObject({ command: "connect", message: "peer not found" });
  // Late commands for an endpoint that is gone are ignored, not fatal.
  runtime.send({ type: "stop", endpoint: 1 });
  runtime.send({ type: "send", endpoint: 1, id: result.id, text: "late" });
  expect(await runtime.next({ type: "closed", endpoint: 2 })).toMatchObject({ id: incoming.id });
  runtime.send({ type: "start", endpoint: 3, seedB64: seed(3) });
  await runtime.next({ type: "started", endpoint: 3 });
  expect(runtime.events.some(e => e.text === "late")).toBe(false);
  expect(alive(runtime.child.pid!)).toBe(true);
});

it("refuses a ninth endpoint and an invalid seed without stopping the others", async () => {
  const runtime = sidecar();
  for (let n = 1; n <= 8; n++) runtime.send({ type: "start", endpoint: n, seedB64: seed(n) });
  await runtime.next({ type: "started", endpoint: 8 });
  runtime.send({ type: "start", endpoint: 9, seedB64: seed(9) });
  expect(await runtime.next({ type: "error", endpoint: 9 })).toMatchObject({ command: "start", message: "Native endpoint limit reached" });
  runtime.send({ type: "stop", endpoint: 8 });
  runtime.send({ type: "start", endpoint: 10, seedB64: "short" });
  expect(await runtime.next({ type: "error", endpoint: 10 })).toMatchObject({ command: "start", message: "Invalid native seed" });
  expect(alive(runtime.child.pid!)).toBe(true);
});

it("exits when the app's pipe closes, even if an endpoint never finishes closing", async () => {
  const runtime = sidecar({ FAKE_ENDPOINT_HANG_CLOSE: "1" });
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  await runtime.next({ type: "started", endpoint: 1 });
  const closing = Date.now();
  runtime.child.stdin!.end();
  expect(await runtime.exited).toBe(0);
  expect(Date.now() - closing).toBeLessThan(5000);
});

it("exits when its parent is killed, though its input stays open", async () => {
  // Its input is a FIFO this test holds open (a child's stdin pipe would be
  // closed by Node when that child exits), so only the parent check can end it.
  const fifo = join(folder, `input-${Date.now()}`);
  execFileSync("mkfifo", [fifo]);
  const input = openSync(fifo, constants.O_RDWR);
  const parent = spawn(process.execPath, ["-e", `
    const { openSync } = require("node:fs");
    const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(script)}], { stdio: [openSync(${JSON.stringify(fifo)}, "r"), "inherit", "ignore"] });
    console.log(JSON.stringify({ pid: child.pid })); setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  started.push(parent);
  const lines: Event[] = [];
  createInterface({ input: parent.stdout! }).on("line", line => lines.push(JSON.parse(line)));
  const { pid } = await vi.waitFor(() => lines.find(line => line.pid) ?? Promise.reject(new Error("no pid")), { timeout: 5000 }) as { pid: number };
  pids.push(pid);
  try {
    writeSync(input, JSON.stringify({ type: "start", endpoint: 1, seedB64: seed(1) }) + "\n");
    await vi.waitFor(() => expect(lines).toContainEqual(expect.objectContaining({ type: "started", endpoint: 1 })), { timeout: 5000 });
    parent.kill("SIGKILL");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8000, interval: 100 });
  } finally { closeSync(input); }
}, 15_000);

it("exits on anything its host would never send", async () => {
  for (const line of ["not json", JSON.stringify({ type: "send", id: 1 }), JSON.stringify({ type: "exec", endpoint: 1 })]) {
    const runtime = sidecar();
    runtime.child.stdin!.write(line + "\n");
    expect(await runtime.exited).toBe(0);
  }
});
