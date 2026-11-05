import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: settings.network.relay-only

/*
 * Hide my IP from contacts (`relayOnly`) on the Desktop, whose transport reaches the DHT itself (`configure`): a contact
 * running DHT nodes near a chat's keys would see this device poll them. While it is on, the Desktop is told to keep
 * off the DHT (`dhtDirect: false`), reading and writing through the relays alone; off, the DHT again (WISP 100 § Relay
 * only). Rust's side, no datagram to a DHT node: `pkarr_network.rs` `relays_only_sends_no_datagram_to_the_dht...`.
 */

const TURN = { urls: "turn:turn.example.org:3478", username: "u", credential: "p" };
const RELAYS = ["https://relay.example.org"];

const nodes: GhostlyNode[] = [];
function desktop() {
  const configure = vi.fn();
  const transport = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }), configure };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: transport as never, automaticWallets: false, nativeTransports: {} });
  nodes.push(node);
  return { node, configure };
}

beforeEach(async () => {
  await transact([STORES.settings, STORES.links], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

it("tells the Desktop at the start to keep off the DHT while it is on, and to use it while it is off", async () => {
  await db.putSettings({ online: false, nick: "", relays: RELAYS, iceServers: [TURN], mints: [], mintsInitialized: true, relayOnly: true });
  const on = desktop();
  await on.node.start();
  expect(on.configure).toHaveBeenLastCalledWith({ relays: RELAYS, readRelays: false, dhtDirect: false });

  await db.putSettings({ online: false, nick: "", relays: RELAYS, iceServers: [TURN], mints: [], mintsInitialized: true, readRelays: true });
  const off = desktop();
  await off.node.start();
  expect(off.configure).toHaveBeenLastCalledWith({ relays: RELAYS, readRelays: true, dhtDirect: true });
});

it("turns the Desktop's DHT off and on with the switch, and keeps it off through other network saves", async () => {
  const { node, configure } = desktop();
  await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
  expect(configure).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ readRelays: false, dhtDirect: false }));

  await node.updateSettings({ settings: { readRelays: true } });
  await node.updateSettings({ settings: { relays: RELAYS } });
  expect(configure).toHaveBeenLastCalledWith({ relays: RELAYS, readRelays: true, dhtDirect: false });
  configure.mockClear();
  await node.updateSettings({ settings: { nick: "ana" } });
  expect(configure).not.toHaveBeenCalled();

  await node.updateSettings({ settings: { relayOnly: false } });
  expect(configure).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenLastCalledWith({ relays: RELAYS, readRelays: true, dhtDirect: true });
});
