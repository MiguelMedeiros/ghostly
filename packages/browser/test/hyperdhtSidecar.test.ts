import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, copyFileSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, expect, it, vi } from "vitest";
// covers: transport.native-pool

// The desktop's HyperDHT sidecar, as the app runs it, over endpoints held in
// memory instead of the DHT: one process for every endpoint, gone with its parent.
const source = resolve(__dirname, "../../../native/transports/hyperdht");
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

it("carries a binary message both ways, as base64 on the line", async () => {
  const runtime = sidecar();
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  runtime.send({ type: "start", endpoint: 2, seedB64: seed(2) });
  const b = await runtime.next({ type: "started", endpoint: 2 });
  await runtime.next({ type: "started", endpoint: 1 });
  runtime.send({ type: "connect", endpoint: 1, descriptor: b.descriptor });
  const result = await runtime.next({ type: "result", endpoint: 1 });
  const incoming = await runtime.next({ type: "open", endpoint: 2, incoming: true });

  const bytes = Buffer.from([0x04, 0, 255, 10]).toString("base64");
  runtime.send({ type: "send", endpoint: 1, id: result.id, bytes });
  const frame = await runtime.next({ type: "frame", endpoint: 2 });
  expect(frame).toEqual({ type: "frame", endpoint: 2, id: incoming.id, bytes });
  runtime.send({ type: "send", endpoint: 2, id: incoming.id, text: "and text" });
  expect(await runtime.next({ type: "frame", endpoint: 1 })).toEqual({ type: "frame", endpoint: 1, id: result.id, text: "and text" });
  expect(alive(runtime.child.pid!)).toBe(true);
});

it("carries a frame that JSON makes six times longer, with every endpoint still up", async () => {
  const runtime = sidecar();
  for (const n of [1, 2, 3]) runtime.send({ type: "start", endpoint: n, seedB64: seed(n) });
  const b = await runtime.next({ type: "started", endpoint: 2 });
  await runtime.next({ type: "started", endpoint: 1 });
  await runtime.next({ type: "started", endpoint: 3 });
  runtime.send({ type: "connect", endpoint: 1, descriptor: b.descriptor });
  const result = await runtime.next({ type: "result", endpoint: 1 });
  const incoming = await runtime.next({ type: "open", endpoint: 2, incoming: true });
  // A contact's largest text frame, all control characters: `\u0001` on the line, a line of about 360 KiB.
  const text = "\u0001".repeat(60 * 1024);
  expect(JSON.stringify({ text }).length).toBeGreaterThan(6 * 60 * 1024);
  runtime.send({ type: "send", endpoint: 1, id: result.id, seq: 1, text });
  expect(await runtime.next({ type: "frame", endpoint: 2 })).toMatchObject({ id: incoming.id, text });
  expect(runtime.events.some(e => e.type === "closed" || e.type === "stopped")).toBe(false);
  expect(alive(runtime.child.pid!)).toBe(true);
});

it("says once that a socket is full and once that it has room, nothing for a frame that fits, and names a refused one", async () => {
  // A link slower than the app sends: each frame waits 300 ms in the socket's buffer.
  const runtime = sidecar({ FAKE_ENDPOINT_DELAY_MS: "300" });
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  runtime.send({ type: "start", endpoint: 2, seedB64: seed(2) });
  const b = await runtime.next({ type: "started", endpoint: 2 });
  await runtime.next({ type: "started", endpoint: 1 });
  runtime.send({ type: "connect", endpoint: 1, descriptor: b.descriptor });
  const result = await runtime.next({ type: "result", endpoint: 1 });
  await runtime.next({ type: "open", endpoint: 2, incoming: true });

  const frame = "x".repeat(60 * 1024);
  for (const seq of [1, 2, 3]) runtime.send({ type: "send", endpoint: 1, id: result.id, seq, text: frame });
  // The first fits in the socket's room; the second fills it, and the host hears that once, before any frame left.
  await runtime.next({ type: "full", endpoint: 1, id: result.id });
  expect(runtime.events.some(e => e.type === "frame")).toBe(false);
  // Once it drained: `room`, after every frame reached the other end. A word back for each frame cost a file about
  // a fifth of its speed on the Desktop.
  await runtime.next({ type: "room", endpoint: 1, id: result.id });
  expect(runtime.events.filter(e => e.type === "frame" && e.endpoint === 2)).toHaveLength(3);
  expect(runtime.events.filter(e => e.endpoint === 1 && ["full", "room", "sent"].includes(e.type as string)).map(e => e.type)).toEqual(["full", "room"]);

  // A send the runtime cannot make is answered, under its number, not dropped unseen.
  runtime.send({ type: "send", endpoint: 1, id: 999, seq: 4, text: "nowhere" });
  expect(await runtime.next({ type: "error", endpoint: 1, seq: 4 })).toMatchObject({ command: "send", id: 999 });
  expect(alive(runtime.child.pid!)).toBe(true);
}, 15_000);

it("sends on a live connection while the same endpoint's dial is still waiting", async () => {
  // A dial to a contact whose app just died waits 3 s before it fails, as a stale DHT record does.
  const runtime = sidecar({ FAKE_ENDPOINT_DIAL_MS: "3000" });
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  runtime.send({ type: "start", endpoint: 2, seedB64: seed(2) });
  const a = await runtime.next({ type: "started", endpoint: 1 });
  await runtime.next({ type: "started", endpoint: 2 });
  runtime.send({ type: "connect", endpoint: 1, descriptor: { publicKey: "00".repeat(32) } });
  // The contact comes back and dials in: the chat answers on that connection at once.
  runtime.send({ type: "connect", endpoint: 2, descriptor: a.descriptor });
  const incoming = await runtime.next({ type: "open", endpoint: 1, incoming: true });
  runtime.send({ type: "send", endpoint: 1, id: incoming.id, seq: 1, text: "back" });
  runtime.send({ type: "close", endpoint: 1, id: 999 });
  expect(await runtime.next({ type: "frame", endpoint: 2 })).toMatchObject({ text: "back" });
  expect(runtime.events.some(e => e.type === "error" && e.endpoint === 1)).toBe(false);
  // The dial still ends as it would have.
  expect(await runtime.next({ type: "error", endpoint: 1, command: "connect" })).toMatchObject({ message: "peer not found" });
});

it("carries a burst of small frames read at once without stopping the endpoint", async () => {
  const runtime = sidecar();
  runtime.send({ type: "start", endpoint: 1, seedB64: seed(1) });
  runtime.send({ type: "start", endpoint: 2, seedB64: seed(2) });
  const b = await runtime.next({ type: "started", endpoint: 2 });
  await runtime.next({ type: "started", endpoint: 1 });
  runtime.send({ type: "connect", endpoint: 1, descriptor: b.descriptor });
  const result = await runtime.next({ type: "result", endpoint: 1 });
  await runtime.next({ type: "open", endpoint: 2, incoming: true });
  // A catch-up of 200 short messages, in one write: the runtime reads them in one go.
  const burst = Array.from({ length: 200 }, (_, n) => JSON.stringify({ type: "send", endpoint: 1, id: result.id, seq: n + 1, text: `m${n}` }) + "\n");
  runtime.child.stdin!.write(burst.join(""));
  await runtime.next({ type: "frame", endpoint: 2, text: "m199" });
  expect(runtime.events.filter(e => e.type === "frame" && e.endpoint === 2).map(e => e.text)).toEqual(burst.map((_, n) => `m${n}`));
  expect(runtime.events.some(e => e.type === "stopped" || e.type === "closed")).toBe(false);
}, 10_000);

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
