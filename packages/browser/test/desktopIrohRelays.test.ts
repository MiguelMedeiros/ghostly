import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdentity, type NativeEndpoint } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { DEFAULT_IROH_RELAYS } from "../src/platform/irohWeb";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: transport.iroh, settings.network.iroh-relays

/*
 * The Desktop's own Iroh on the person's Iroh relays (Settings, Network), as the web app's Iroh: the host's factory is
 * given them when the person set any, and its own defaults (n0's) otherwise. A host that does not say it takes relays
 * is called as before, with the seed alone.
 */

function fakeEndpoint(): NativeEndpoint {
  return { transport: "iroh/1", descriptor: { id: "ab".repeat(32), relay: null, addresses: [] }, onConnection: null, onDescriptor: null,
    connect: vi.fn(), close: vi.fn(async () => {}) };
}
function stubLink() {
  const available = ["webrtc/1"] as string[];
  return {
    available,
    get availableTransports() { return [...available]; },
    registerEndpoint: vi.fn((endpoint: NativeEndpoint) => { available.push(endpoint.transport); }),
    canReleaseEndpoint: vi.fn(() => true),
    releaseEndpoint: vi.fn(async (transport: string) => { available.splice(available.indexOf(transport), 1); }),
    isDataLinkOpen: false, allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    setNick: vi.fn(), setAvatar: vi.fn(), refreshServices: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), wake: vi.fn(), depart: vi.fn(), session: { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() },
  };
}
async function addChat(node: GhostlyNode, link: ReturnType<typeof stubLink>) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}
const nodes: GhostlyNode[] = [];
function engine(options: ConstructorParameters<typeof GhostlyNode>[1] = {}) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, ...options });
  nodes.push(node);
  return node;
}

beforeEach(async () => {
  await transact([STORES.settings, STORES.links], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

it("homes the Desktop's own Iroh on the person's Iroh relays, moves idle chats when they change, and shows them in Settings", async () => {
  const iroh = vi.fn(async (_seed: string, _options?: { relays?: string[] }) => fakeEndpoint());
  const node = engine({ nativeTransports: { "iroh/1": iroh }, nativeIrohRelays: true });
  // Settings, Network shows the Iroh relays here too, with n0's as the defaults.
  expect(node.getState().transport.iroh).toEqual({ relays: [...DEFAULT_IROH_RELAYS], defaults: [...DEFAULT_IROH_RELAYS] });
  const link = stubLink();
  const chat = await addChat(node, link);
  await node["ensureNativeEndpoints"](chat.id);
  // None chosen: the host's own defaults.
  expect(iroh).toHaveBeenCalledTimes(1);
  expect(iroh.mock.calls[0][1]).toEqual({});

  await node.updateSettings({ settings: { irohRelays: ["http://127.0.0.1:3340/"] } });
  await vi.waitFor(() => expect(iroh).toHaveBeenCalledTimes(2));
  expect(link.releaseEndpoint).toHaveBeenCalledWith("iroh/1");
  expect(iroh.mock.calls[1][1]).toEqual({ relays: ["http://127.0.0.1:3340/"] });
  expect(node.getState().transport.iroh?.relays).toEqual(["http://127.0.0.1:3340/"]);
});

it("calls a host's Iroh with the seed alone where the host does not take relays", async () => {
  const iroh = vi.fn(async (..._args: unknown[]) => fakeEndpoint());
  const node = engine({ nativeTransports: { "iroh/1": iroh } });
  await node.updateSettings({ settings: { irohRelays: ["http://127.0.0.1:3340/"] } });
  expect(node.getState().transport.iroh).toBeUndefined();
  const link = stubLink();
  const chat = await addChat(node, link);
  await node["ensureNativeEndpoints"](chat.id);
  expect(iroh).toHaveBeenCalledTimes(1);
  expect(iroh.mock.calls[0]).toHaveLength(1);
});
