import { afterAll, beforeAll, expect, it } from "vitest";
import type { BoundChannel, NativeEndpoint } from "@ghostly/core";
// covers: transport.hyperdht

/**
 * The Desktop's and the CLI's HyperDHT endpoint (native/transports/hyperdht/endpoint.mjs) on a HyperDHT network of its
 * own, on loopback: what a channel still holds counts in its `bufferedAmount`, so a sender holds back on a slow link.
 * Before, it read a Node stream property secret-stream does not have, and was always 0: the sidecar's `SEND_ROOM`,
 * the channel's own limit and the CLI's high water mark never held a sender back, and a file piled up unbounded ahead
 * of every text.
 */

type Testnet = { bootstrap: { host: string; port: number }[]; destroy(): Promise<void> };

let net: Testnet;
const opened: NativeEndpoint[] = [];

beforeAll(async () => {
  const { default: testnet } = await import("hyperdht/testnet.js");
  net = await testnet(3, { host: "127.0.0.1" });
}, 30_000);
afterAll(async () => {
  await Promise.allSettled(opened.map((item) => item.close()));
  await net?.destroy();
});

async function endpoint(): Promise<NativeEndpoint> {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const made = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap: net.bootstrap, host: "127.0.0.1" } as never);
  opened.push(made);
  return made;
}

/** Alice's end of a channel to Bob, and how many frames Bob read. */
async function pair(): Promise<{ mine: BoundChannel; heard: () => number; last: () => string | undefined }> {
  const [alice, bob] = [await endpoint(), await endpoint()];
  const theirs = new Promise<BoundChannel>((resolve) => { bob.onConnection = resolve; });
  const mine = await alice.connect(bob.descriptor);
  const { channel } = await theirs;
  let count = 0, last: string | undefined;
  channel.onMessage = (data) => { count++; if (typeof data === "string" && data.length < 100) last = data; };
  return { mine, heard: () => count, last: () => last };
}

const KIB = 1024;
/** A frame of 60 KiB less its header room, as a file's chunk or a large message. */
const frame = "x".repeat(60 * KIB - 16);

it("counts what the stream still holds, and drained() waits until it went out", async () => {
  const { mine, heard } = await pair();
  // A sender that keeps under a 1 MiB high water mark, as the CLI's does, writing faster than the link carries.
  let sent = 0, most = 0;
  while (sent < 160 && mine.channel.bufferedAmount < 1024 * KIB) {
    mine.channel.send(frame); sent++;
    most = Math.max(most, mine.channel.bufferedAmount);
  }
  // Before: 160 frames (9.6 MiB) went with bufferedAmount 0 after each.
  expect(most).toBeGreaterThanOrEqual(1024 * KIB);
  expect(sent).toBeLessThan(160);
  let drained = false;
  const waiting = mine.channel.drained().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  await waiting;
  expect(mine.channel.bufferedAmount).toBeLessThanOrEqual(64 * KIB);
  await expect.poll(heard, { timeout: 10_000 }).toBe(sent);
}, 30_000);

it("refuses a frame past what any sender here lets itself queue, and still carries the rest", async () => {
  const { mine, heard, last } = await pair();
  let sent = 0, refused: unknown = null;
  for (; sent < 160; sent++) {
    try { mine.channel.send(frame); } catch (error) { refused = error; break; }
  }
  // Before: all 160 went, none refused.
  expect(refused).toBeInstanceOf(Error);
  expect(sent * frame.length).toBeGreaterThan(1024 * KIB);
  await mine.channel.drained();
  mine.channel.send("after");
  await expect.poll(last, { timeout: 10_000 }).toBe("after");
  expect(heard()).toBe(sent + 1);
}, 30_000);
