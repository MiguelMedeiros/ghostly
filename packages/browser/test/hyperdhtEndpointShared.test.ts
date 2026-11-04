import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { BoundChannel, NativeEndpoint } from "@ghostly/core";
// covers: transport.hyperdht

/**
 * The Desktop's and the CLI's HyperDHT endpoint (native/transports/hyperdht/endpoint.mjs) on a HyperDHT network of its
 * own, on loopback. Every chat's listener had its own DHT node (a UDP socket, a routing table) and stayed announced
 * while its chat was live on it: hyperdht pings each announced listener's three relays every 3 s, about 62 requests a
 * minute per chat whether anyone dials it or not (1,050 a minute for eight live chats in the lab). Now the chats of an
 * app share one node, and a listener is announced only while its chat has no live channel.
 */

type Node = { destroyed: boolean; destroy(): Promise<void>; findPeer(key: Uint8Array): AsyncIterable<{ peer?: unknown }> };
type Testnet = { nodes: { io: { onrequest: (req: Request, external: boolean) => void } }[]; bootstrap: { host: string; port: number }[]; destroy(): Promise<void> };
type Request = { internal: boolean; command: number; from: { port: number } };

const built = vi.hoisted(() => [] as Node[]);
vi.mock("hyperdht", async (original) => {
  const DHT = (await original<{ default: new (options: object) => Node }>()).default;
  class Seen extends DHT {
    constructor(options: object) { super(options); built.push(this); }
  }
  return { default: Seen };
});

let net: Testnet;
/** Every request the network's nodes took: internal (dht-rpc's PING, FIND_NODE…) or hyperdht's, by command, and from which port. */
const heard: Request[] = [];
const opened: NativeEndpoint[] = [];

beforeAll(async () => {
  const { default: testnet } = await import("hyperdht/testnet.js");
  net = await testnet(5, { host: "127.0.0.1" }) as unknown as Testnet;
  for (const node of net.nodes) {
    const take = node.io.onrequest;
    node.io.onrequest = (req, external) => { heard.push(req); take(req, external); };
  }
}, 30_000);
afterEach(async () => { await Promise.allSettled(opened.splice(0).map((item) => item.close())); });
afterAll(async () => { await net?.destroy(); });

async function endpoint(seed = crypto.getRandomValues(new Uint8Array(32))): Promise<NativeEndpoint> {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const made = await createHyperEndpoint(seed, { bootstrap: net.bootstrap, host: "127.0.0.1" } as never);
  opened.push(made);
  return made;
}

async function dial(from: NativeEndpoint, to: NativeEndpoint): Promise<{ mine: BoundChannel; theirs: BoundChannel }> {
  const theirs = new Promise<BoundChannel>((resolve) => { to.onConnection = resolve; });
  const mine = await from.connect(to.descriptor);
  return { mine, theirs: await theirs };
}

async function says(from: BoundChannel, to: BoundChannel, text: string): Promise<void> {
  const got = new Promise<string>((resolve) => { to.channel.onMessage = (value) => resolve(String(value)); });
  from.channel.send(text);
  expect(await got).toBe(text);
}

/** Whether `endpoint`'s listener is announced: asked from a node of its own, as a contact's app would. */
async function announced(endpoint: NativeEndpoint): Promise<boolean> {
  const { default: DHT } = await vi.importActual<{ default: new (options: object) => Node }>("hyperdht");
  const asker = new DHT({ bootstrap: net.bootstrap, host: "127.0.0.1", ephemeral: true });
  try {
    const key = Uint8Array.from((endpoint.descriptor as { publicKey: string }).publicKey.match(/../g)!, (byte) => parseInt(byte, 16));
    for await (const reply of asker.findPeer(key)) if (reply.peer) return true;
    return false;
  } finally { await asker.destroy(); }
}

/** The PINGs (dht-rpc's command 0) the network's nodes took in `ms` from now. */
async function pingsIn(ms: number): Promise<number> {
  const from = heard.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return heard.slice(from).filter((req) => req.internal && req.command === 0).length;
}

it("every chat's listener runs on one DHT node, which stays until the last one closes", async () => {
  const before = built.length;
  const [one, two, three] = [await endpoint(), await endpoint(), await endpoint()];
  expect(built.length - before).toBe(1);
  const node = built.at(-1)!;
  // One asking port for all three: the requests the network takes from this app now come from one socket.
  const from = heard.length;
  await new Promise((resolve) => setTimeout(resolve, 3500));
  expect(new Set(heard.slice(from).map((req) => req.from.port)).size).toBe(1);

  // A chat's listener closing leaves the node and the others: the third still reaches the first, live.
  await two.close();
  expect(node.destroyed).toBe(false);
  const { mine, theirs } = await dial(three, one);
  await says(mine, theirs, "still here");

  await Promise.all([one.close(), three.close()]);
  expect(node.destroyed).toBe(true);
  // The next chat's listener gets a node again.
  await endpoint();
  expect(built.length - before).toBe(2);
}, 30_000);

it("a chat's listener is not announced while its chat is live on it, and is again once that ends", async () => {
  const [alice, bob] = [await endpoint(), await endpoint()];
  expect(await announced(bob)).toBe(true);
  // Two listeners announced: their relays pinged every 3 s.
  expect(await pingsIn(6500)).toBeGreaterThanOrEqual(8);

  const { mine, theirs } = await dial(alice, bob);
  // Live: neither side announces its listener (Alice dialled out on hers), and the session goes on unharmed.
  await vi.waitFor(async () => { expect(await announced(bob)).toBe(false); }, { timeout: 10_000, interval: 500 });
  expect(await announced(alice)).toBe(false);
  expect(await pingsIn(6500)).toBeLessThanOrEqual(2);
  await says(mine, theirs, "live without a listener");
  // Past hyperdht's 10 s handshake window too, which `server.suspend()` would have ended the stream in.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await says(theirs, mine, "and later");

  // The session ends: both listen again, and the contact reaches Bob's.
  const ended = new Promise<void>((resolve) => { theirs.channel.onClose = () => resolve(); });
  mine.channel.close();
  await ended;
  await vi.waitFor(async () => { expect(await announced(bob)).toBe(true); }, { timeout: 10_000, interval: 500 });
  const again = await dial(alice, bob);
  await says(again.mine, again.theirs, "back");
}, 60_000);

it("a chat's listener started again while its last one is still closing listens on the same key", async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const [first, caller] = [await endpoint(seed), await endpoint()];
  const live = await dial(caller, first);
  // Closing waits for its live channel to end; the new one does not fail on a key the node still holds.
  void first.close();
  const second = await endpoint(seed);
  const { mine, theirs } = await dial(caller, second);
  await says(mine, theirs, "same chat");
  live.mine.channel.close();
}, 30_000);
