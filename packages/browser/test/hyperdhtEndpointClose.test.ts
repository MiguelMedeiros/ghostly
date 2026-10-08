import { afterAll, beforeAll, expect, it } from "vitest";
import type { BoundChannel, NativeEndpoint } from "@ghostly/core";
// covers: transport.hyperdht

/**
 * The Desktop's and the CLI's HyperDHT endpoint (native/transports/hyperdht/endpoint.mjs) on a HyperDHT network of its
 * own, on loopback. An app that stops says goodbye (`paired-bye`) on its live sessions and closes its endpoints right
 * after (engine shutdown, #1452): the goodbye must still reach the contact. Before, the stream was destroyed with the
 * frame still unsent, and the contact heard only the close (bug hunt bh-zero18).
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

/** Bob's end of a channel Alice dialled, with what it read and whether it closed. */
async function pair(): Promise<{ alice: NativeEndpoint; mine: BoundChannel; heard: string[]; closed: Promise<void> }> {
  const [alice, bob] = [await endpoint(), await endpoint()];
  const theirs = new Promise<BoundChannel>((resolve) => { bob.onConnection = resolve; });
  const mine = await alice.connect(bob.descriptor);
  const { channel } = await theirs;
  const heard: string[] = [];
  channel.onMessage = (text) => heard.push(String(text));
  const closed = new Promise<void>((resolve) => { channel.onClose = () => resolve(); });
  return { alice, mine, heard, closed };
}

it("a frame sent just before the endpoint closes reaches the contact before the close", async () => {
  const { alice, mine, heard, closed } = await pair();
  mine.channel.send(JSON.stringify({ t: "paired-bye" }));
  await alice.close();
  await closed;
  expect(heard).toEqual(['{"t":"paired-bye"}']);
}, 20_000);

it("a frame sent just before its channel closes reaches the contact, and the contact sees the close", async () => {
  const { mine, heard, closed } = await pair();
  mine.channel.send("last words");
  mine.channel.close();
  await closed;
  expect(heard).toEqual(["last words"]);
}, 20_000);
