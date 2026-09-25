import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdentity, type NativeEndpoint } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: transport.hyperdht-relay, settings.network.hyperdht-relay

const relayed = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/platform/hyperdhtRelay", () => ({ createRelayedHyperEndpoint: relayed.create }));

function fakeEndpoint(): NativeEndpoint {
  return { transport: "hyperdht/1", descriptor: { publicKey: "ab".repeat(32), relayed: true }, onConnection: null, onDescriptor: null,
    connect: vi.fn(), close: vi.fn(async () => {}) };
}
/** A chat's link as the engine drives it: which endpoints it holds, and whether it may give one up. */
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
    stop: vi.fn(async () => {}), wake: vi.fn(), session: { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() },
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
  relayed.create.mockReset().mockImplementation(async () => fakeEndpoint());
  await transact([STORES.settings, STORES.links], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.useRealTimers(); });

it("takes a wss:// relay (or ws:// to this machine), refuses anything else, and keeps none as the default", async () => {
  const node = engine();
  for (const bad of ["ws://relay.example", "https://relay.example", "relay.example", 7 as never])
    await expect(node.updateSettings({ settings: { hyperdhtRelay: bad } })).rejects.toThrow();
  expect(await db.getSettings()).toEqual({});
  await node.updateSettings({ settings: { hyperdhtRelay: "  wss://relay.example  " } });
  expect((await db.getSettings()).hyperdhtRelay).toBe("wss://relay.example");
  expect(node.getState().settings.hyperdhtRelay).toBe("wss://relay.example");
  await node.updateSettings({ settings: { hyperdhtRelay: "ws://127.0.0.1:49443" } });
  await node.updateSettings({ settings: { hyperdhtRelay: "" } });
  expect((await db.getSettings()).hyperdhtRelay).toBeUndefined();
});

it("offers a browser HyperDHT only through the relay that is set, and a Desktop keeps its own", async () => {
  const node = engine();
  const link = stubLink();
  const chat = await addChat(node, link);
  await node["ensureNativeEndpoints"](chat.id);
  expect(relayed.create).not.toHaveBeenCalled();
  expect(link.registerEndpoint).not.toHaveBeenCalled();

  await node.updateSettings({ settings: { hyperdhtRelay: "wss://relay.example" } });
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(1));
  expect(relayed.create).toHaveBeenCalledWith(expect.any(String), "wss://relay.example");
  // The chat's own transport seed, saved, as on the Desktop.
  expect(relayed.create.mock.calls[0][0]).toBe((await db.getLinks()).find(l => l.id === chat.id)?.transportSeeds?.["hyperdht/1"]);

  const desktop = engine({ nativeTransports: { "hyperdht/1": vi.fn(async () => fakeEndpoint()) } });
  await desktop.updateSettings({ settings: { hyperdhtRelay: "wss://relay.example" } });
  const other = stubLink();
  const desktopChat = await addChat(desktop, other);
  relayed.create.mockClear();
  await desktop["ensureNativeEndpoints"](desktopChat.id);
  expect(relayed.create).not.toHaveBeenCalled();
  expect(other.registerEndpoint).toHaveBeenCalledTimes(1);
});

it("says why when the relay cannot be reached, and moves chats to a new relay or to none", async () => {
  const node = engine();
  const link = stubLink();
  const chat = await addChat(node, link);
  relayed.create.mockRejectedValueOnce(new Error("Could not reach the HyperDHT relay"));
  await node.updateSettings({ settings: { hyperdhtRelay: "wss://down.example" } });
  await vi.waitFor(() => expect(node.getState().links.find(l => l.id === chat.id)?.transportErrors?.["hyperdht/1"]).toMatch(/Could not reach/));
  expect(link.registerEndpoint).not.toHaveBeenCalled();

  await node.updateSettings({ settings: { hyperdhtRelay: "wss://up.example" } });
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(1));
  expect(node.getState().links.find(l => l.id === chat.id)?.transportErrors?.["hyperdht/1"]).toBeUndefined();

  await node.updateSettings({ settings: { hyperdhtRelay: "wss://other.example" } });
  await vi.waitFor(() => expect(relayed.create).toHaveBeenLastCalledWith(expect.any(String), "wss://other.example"));
  expect(link.releaseEndpoint).toHaveBeenCalledWith("hyperdht/1");

  await node.updateSettings({ settings: { hyperdhtRelay: "" } });
  expect(link.availableTransports).toEqual(["webrtc/1"]);
  const calls = relayed.create.mock.calls.length;
  await node["ensureNativeEndpoints"](chat.id);
  expect(relayed.create).toHaveBeenCalledTimes(calls);
});

it("leaves a chat's session on the old relay alone until it can let go", async () => {
  const node = engine();
  const link = stubLink();
  await addChat(node, link);
  await node.updateSettings({ settings: { hyperdhtRelay: "wss://a.example" } });
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(1));
  link.canReleaseEndpoint.mockReturnValue(false);
  await node.updateSettings({ settings: { hyperdhtRelay: "wss://b.example" } });
  expect(link.releaseEndpoint).not.toHaveBeenCalled();
  expect(link.registerEndpoint).toHaveBeenCalledTimes(1);
});

it("listens again a while after the relay went away", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const node = engine();
  const link = stubLink();
  const chat = await addChat(node, link);
  await node.updateSettings({ settings: { hyperdhtRelay: "wss://relay.example" } });
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(1));
  // The relay dropped: GhostLink removed the endpoint and said its transports changed.
  link.available.splice(link.available.indexOf("hyperdht/1"), 1);
  node["retryRelayLater"]();
  await vi.advanceTimersByTimeAsync(29_000);
  expect(link.registerEndpoint).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(2));
  expect(chat.id).toBeTruthy();
});
