import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
// covers: transport.hyperdht

/**
 * The Desktop's HyperDHT sidecar (native/transports/hyperdht/sidecar.mjs) as the Desktop runs it, on a HyperDHT network
 * of its own on loopback, sending a file to a contact that reads at about 4 MB/s (in its own process). The page's side
 * is modelled as apps/ui's HyperDHT channel: 120 KiB of frames the host has not taken yet (here, the pipe to the
 * sidecar), and a file's 16 KiB chunks while under a quarter of that and while the sidecar has not said its socket is
 * `full` (until `room`). A text sent in the middle of the file must not wait behind it.
 * Before, the sidecar read its socket's queue as always 0 and never held the page back, so the page kept writing and
 * the file piled up in the stream ahead of the text.
 */

type Testnet = { bootstrap: { host: string; port: number }[]; destroy(): Promise<void> };

const SIDECAR = fileURLToPath(new URL("../../../native/transports/hyperdht/sidecar.mjs", import.meta.url));
const RECEIVER = fileURLToPath(new URL("./support/slowHyperReceiver.mjs", import.meta.url));
const KIB = 1024;

let net: Testnet;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  const { default: testnet } = await import("hyperdht/testnet.js");
  net = await testnet(3, { host: "127.0.0.1" });
}, 30_000);
afterAll(async () => {
  for (const child of children) { child.stdin.end(); child.kill(); }
  await net?.destroy();
});

/** A child process speaking JSON lines; `next(match)` resolves with the first line `match` takes. */
function child(args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(proc);
  const waiters: { match: (line: Record<string, unknown>) => boolean; resolve: (line: Record<string, unknown>) => void }[] = [];
  const listeners: ((line: Record<string, unknown>) => void)[] = [];
  createInterface({ input: proc.stdout }).on("line", (text) => {
    const line = JSON.parse(text) as Record<string, unknown>;
    for (const listen of listeners) listen(line);
    const at = waiters.findIndex((waiter) => waiter.match(line));
    if (at >= 0) waiters.splice(at, 1)[0].resolve(line);
  });
  return {
    // A sidecar told to stop still says `room` once it drained while it closes (up to 3 s); the page's listener
    // answers that with more chunks, after afterAll ended the pipe: they are dropped, not written after its end.
    write: (value: unknown, written?: () => void) => !proc.stdin.writableEnded && proc.stdin.write(JSON.stringify(value) + "\n", written),
    next: (match: (line: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve) => { waiters.push({ match, resolve }); }),
    on: (listen: (line: Record<string, unknown>) => void) => { listeners.push(listen); },
  };
}

it("a text sent in the middle of a file reaches a slow contact in under a second", async () => {
  const bootstrap = net.bootstrap.map(({ host, port }) => `${host}:${port}`).join(",");
  const receiver = child([RECEIVER, JSON.stringify(net.bootstrap), "4"]);
  const { descriptor } = await receiver.next((line) => "descriptor" in line);
  const sidecar = child([SIDECAR], { GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap });
  sidecar.write({ type: "start", endpoint: 1, seedB64: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") });
  await sidecar.next((line) => line.type === "started");
  sidecar.write({ type: "connect", endpoint: 1, descriptor });
  const { id } = await sidecar.next((line) => line.type === "result");

  // The page: frames the host has not taken, and a file's chunks while under a quarter of its budget and not `full`.
  const budget = 120 * KIB, chunk = new Uint8Array(16 * KIB).fill(7), file = 32 * 1024 * KIB;
  let seq = 0, buffered = 0, offset = 0, full = false, over = false;
  const send = (frame: { text: string } | { bytes: string }, size: number) => {
    expect(buffered + size).toBeLessThanOrEqual(budget);
    buffered += size;
    sidecar.write({ type: "send", endpoint: 1, id, seq: ++seq, ...frame }, () => { buffered -= size; more(); });
  };
  const bytes = Buffer.from(chunk).toString("base64");
  const more = () => { while (offset < file && !full && buffered < budget / 4) { send({ bytes }, chunk.length); offset += chunk.length; } };
  sidecar.on((line) => {
    // Once the test is over, afterAll stops the contact first: the chunks still on their way to the sidecar then go to
    // a closed connection, and each is an error by design (never a frame lost unseen).
    if (over) return;
    if (line.type === "error") throw new Error(String(line.message));
    if (line.type === "full" || line.type === "room") { full = line.type === "full"; more(); }
  });
  more();

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const heard = receiver.next((line) => line.text === "hello");
  const sentAt = Date.now();
  send({ text: "hello" }, 5);
  const { at } = await Promise.race([heard, new Promise<{ at: number }>((resolve) => setTimeout(() => resolve({ at: Infinity }), 15_000))]);
  // Before: the text waited about 5 s behind the file's pile, or longer.
  expect((at as number) - sentAt).toBeLessThan(1_000);
  // The page was held back as the link is: before, it had handed the sidecar all 32 MiB within the 3 s.
  expect(offset).toBeLessThan(file);
  over = true;
}, 40_000);
