import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { BoundChannel, NativeEndpoint } from "@ghostly/core";
// covers: transport.hyperdht

/**
 * The Desktop's and the CLI's HyperDHT endpoint (native/transports/hyperdht/endpoint.mjs) is a chat's listener: it
 * listens for its one contact and dials out. Built as an adaptive node, it turned into a persistent public DHT node
 * after about 20 minutes wherever its UDP port was reachable (a bot on a VPS), and held strangers' records and values
 * (up to 65,536 records and 65,536 values each, eight per daemon). dht-rpc makes that switch only on an adaptive node,
 * so the node is checked as built, and it still reaches its contact.
 */

const built = vi.hoisted(() => [] as { ephemeral: boolean; adaptive: boolean }[]);
vi.mock("hyperdht", async (original) => {
  const DHT = (await original<{ default: new (options: object) => { ephemeral: boolean; adaptive: boolean } }>()).default;
  class Seen extends DHT {
    constructor(options: object) { super(options); built.push(this); }
  }
  return { default: Seen };
});

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

it("a chat's listener stays an ephemeral DHT client for good, and still reaches its contact", async () => {
  const [alice, bob] = [await endpoint(), await endpoint()];
  expect(built.slice(-2).map(({ ephemeral, adaptive }) => ({ ephemeral, adaptive }))).toEqual([
    { ephemeral: true, adaptive: false },
    { ephemeral: true, adaptive: false },
  ]);
  const theirs = new Promise<BoundChannel>((resolve) => { bob.onConnection = resolve; });
  const mine = await alice.connect(bob.descriptor);
  const { channel } = await theirs;
  const heard = new Promise<string>((resolve) => { channel.onMessage = (text) => resolve(String(text)); });
  mine.channel.send("hello");
  expect(await heard).toBe("hello");
}, 20_000);
