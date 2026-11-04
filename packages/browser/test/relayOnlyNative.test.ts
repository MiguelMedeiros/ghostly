import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeEndpoint } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
// covers: transport.iroh, transport.hyperdht, transport.hyperdht-relay

/*
 * Hide my IP from contacts (`relayOnly`) on the Desktop: its own Iroh lists this device's addresses in its descriptor and
 * its own HyperDHT connects directly, so a contact is offered neither. HyperDHT goes through the HyperDHT relay instead,
 * as in a browser, and is left out with none set. The profile's own devices keep the host's transports.
 */

const TURN = { urls: "turn:turn.example.org:3478", username: "u", credential: "p" };
type Factories = Record<string, unknown>;

const nodes: GhostlyNode[] = [];
function desktop() {
  const iroh = vi.fn(async (): Promise<NativeEndpoint> => { throw new Error("not started here"); });
  const hyperdht = vi.fn(async (): Promise<NativeEndpoint> => { throw new Error("not started here"); });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { automaticWallets: false, nativeTransports: { "iroh/1": iroh, "hyperdht/1": hyperdht }, nativeIrohRelays: true });
  nodes.push(node);
  return { node, iroh, hyperdht };
}

beforeEach(async () => {
  await transact([STORES.settings, STORES.links], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

it("offers contacts no host Iroh or HyperDHT while it is on, HyperDHT through the relay instead; device links keep the host's", async () => {
  const { node, hyperdht } = desktop();
  const off = node["nativeFactories"] as Factories;
  expect(Object.keys(off).sort()).toEqual(["hyperdht/1", "iroh/1"]);
  expect(off["hyperdht/1"]).toBe(hyperdht);

  await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true, hyperdhtRelay: "wss://relay.example.org" } });
  const contacts = node["nativeFactories"] as Factories;
  expect(Object.keys(contacts)).toEqual(["hyperdht/1"]);
  expect(contacts["hyperdht/1"]).not.toBe(hyperdht);
  expect(node["relaysHyperdht"]).toBe(true);
  // The profile's own devices are not contacts.
  const devices = node["deviceNativeFactories"] as Factories;
  expect(Object.keys(devices).sort()).toEqual(["hyperdht/1", "iroh/1"]);
  expect(devices["hyperdht/1"]).toBe(hyperdht);
});

it("leaves HyperDHT out for contacts with no HyperDHT relay set", async () => {
  const { node } = desktop();
  await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true, hyperdhtRelay: "" } });
  expect(Object.keys(node["nativeFactories"] as Factories)).toEqual([]);
  expect(Object.keys(node["deviceNativeFactories"] as Factories).sort()).toEqual(["hyperdht/1", "iroh/1"]);
});
