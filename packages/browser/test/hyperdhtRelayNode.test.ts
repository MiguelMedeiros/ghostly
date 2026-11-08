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
  const endpoints: NativeEndpoint[] = [];
  return {
    available, endpoints,
    get availableTransports() { return [...available]; },
    // As GhostLink: an endpoint that says it is unavailable is dropped.
    registerEndpoint: vi.fn((endpoint: NativeEndpoint) => {
      available.push(endpoint.transport);
      endpoints.push(endpoint);
      endpoint.onUnavailable = () => { if (available.includes(endpoint.transport)) available.splice(available.indexOf(endpoint.transport), 1); };
    }),
    canReleaseEndpoint: vi.fn(() => true), canYieldEndpoint: vi.fn(() => false), lastActivityAt: 0,
    releaseEndpoint: vi.fn(async (transport: string) => { available.splice(available.indexOf(transport), 1); }),
    isDataLinkOpen: false, allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    setNick: vi.fn(), setAvatar: vi.fn(), refreshServices: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), wake: vi.fn(), depart: vi.fn(), session: { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() },
  };
}
async function addChat(node: GhostlyNode, link: ReturnType<typeof stubLink>, lastMessageAt = 0) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt, peerAck: 0, lastSyncAt: 0,
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
  for (const bad of ["ws://relay.example", "https://relay.example", "relay.example", 7 as never,
    "wss://alice:hunter2@relay.example", "wss://relay.example/?token=s3cr3t", "wss://relay.example/#s3cr3t"])
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
  // The session ended: at the engine's next tick (each second) it moves to the new relay. Before, it stayed on the old
  // one until the app restarted.
  link.canReleaseEndpoint.mockReturnValue(true);
  node["retryNative"]();
  await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(2));
  expect(link.releaseEndpoint).toHaveBeenCalledWith("hyperdht/1");
  expect(relayed.create).toHaveBeenLastCalledWith(expect.any(String), "wss://b.example");
});

it("while the relay stays out of reach, queues one start per chat at a time, not another every 15 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // Out of reach, a start takes its whole wait to fail (10 s: the relay's open wait, Iroh's online wait), and a
  // transport's starts go one after another. Each failed chat was queued again once its own wait was over, whether
  // or not its last start had even begun: with 20 chats, 700 starts waited after 30 minutes, and still more with 40.
  const chats = 20;
  relayed.create.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("The HyperDHT relay did not answer")), 10_000)));
  const node = engine();
  node["settings"] = { ...node["settings"], hyperdhtRelay: "wss://relay.example" };
  const ids: string[] = [];
  for (let i = 0; i < chats; i++) ids.push((await addChat(node, stubLink())).id);
  const pending = new Map<string, number>();
  let most = 0;
  const ensure = node["ensureNativeEndpoints"].bind(node);
  vi.spyOn(node as never, "ensureNativeEndpoints").mockImplementation(((id: string, inUse?: boolean) => {
    pending.set(id, (pending.get(id) ?? 0) + 1);
    most = Math.max(most, pending.get(id)!);
    return ensure(id, inUse).finally(() => pending.set(id, pending.get(id)! - 1));
  }) as never);
  node["startGroupEntries"]();
  for (const id of ids) void node["ensureNativeEndpoints"](id);
  for (let second = 0; second < 10 * 60; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(relayed.create.mock.calls.length).toBeGreaterThan(chats);
  expect(most).toBe(1);
}, 60_000);

it("listens again a while after the relay went away, each app at a time of its own", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // A relay that restarts closes every app's socket at once: with one fixed wait they all came back in the same
  // instant, and on a relay of 512 apps a fifth of their listens timed out in that burst. The waits now spread over
  // 30 s around the same 30 s.
  for (const [draw, wait] of [[0, 15_000], [0.5, 30_000], [0.999, 44_970]]) {
    const node = engine();
    const link = stubLink();
    await addChat(node, link);
    await node.updateSettings({ settings: { hyperdhtRelay: "wss://relay.example" } });
    await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(1));
    // The relay dropped: GhostLink removed the endpoint and said its transports changed.
    link.available.splice(link.available.indexOf("hyperdht/1"), 1);
    const random = vi.spyOn(Math, "random").mockReturnValue(draw);
    node["retryRelayLater"]();
    random.mockRestore();
    await vi.advanceTimersByTimeAsync(wait - 1_000);
    expect(link.registerEndpoint).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(link.registerEndpoint).toHaveBeenCalledTimes(2));
    await node.shutdown();
  }
});

it("starts the chat opened while the relay is out of reach before every other chat's waiting start", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Out of reach, a start takes its whole wait to fail (10 s), one after another per transport: the chat opened
  // waited behind every other chat's start, 200 s with 20 chats, before its own even began or said why.
  const starts: { seed: string; at: number }[] = [];
  relayed.create.mockImplementation((seed: string) => {
    starts.push({ seed, at: Date.now() });
    return new Promise((_, reject) => setTimeout(() => reject(new Error("The HyperDHT relay did not answer")), 10_000));
  });
  const node = engine();
  node["settings"] = { ...node["settings"], hyperdhtRelay: "wss://relay.example" };
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await addChat(node, stubLink())).id);
  for (const id of ids) void node["ensureNativeEndpoints"](id);
  // A second at a time, the stored seeds written in between (fake-indexeddb answers on setImmediate).
  const run = async (seconds: number) => {
    for (let second = 0; second < seconds; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (let k = 0; k < 4; k++) await new Promise(resolve => setImmediate(resolve));
    }
  };
  await run(1);
  const opened = ids[19], at = Date.now();
  node["onScreen"].add(opened);
  void node["ensureNativeEndpoints"](opened, true);
  await run(20);
  const seed = () => node["links"].get(opened)!.stored.transportSeeds?.["hyperdht/1"];
  const first = starts.find(start => start.seed === seed());
  expect(first && first.at - at).toBeLessThanOrEqual(10_000);
  expect(node.getState().links.find(l => l.id === opened)?.transportErrors?.["hyperdht/1"]).toMatch(/did not answer/);
  // The others still take their turns after it (and after its own start asked before it was opened).
  await run(20);
  expect(starts.filter(start => start.at > first!.at && start.seed !== seed()).length).toBeGreaterThan(0);
}, 60_000);

it.each([12, 20])("with %i paired chats, the chats whose listeners went with a silently lost relay connection get them back", async (count) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // The browser's socket closed with no close reaching the relay (a network switch, a NAT that forgot it): the relay
  // still holds the old connection's keys until its ping drops it (30-60 s, 55 s measured) and refuses them meanwhile.
  // The chats that held no listener had free keys and took the free slots, and the eight that held them found every
  // slot full once their keys were free again, backing off up to 5 minutes, told the slots were in use.
  const run = async (seconds: number) => {
    for (let second = 0; second < seconds; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (let k = 0; k < 4; k++) await new Promise(resolve => setImmediate(resolve));
    }
  };
  const node = engine();
  node["settings"] = { ...node["settings"], hyperdhtRelay: "wss://relay.example" };
  const links: ReturnType<typeof stubLink>[] = [], ids: string[] = [];
  // Newest first, as the app starts them: chat 0 is the one used last.
  for (let i = 0; i < count; i++) {
    const link = stubLink();
    links.push(link);
    ids.push((await addChat(node, link, Date.now() - i * 60_000)).id);
  }
  node["startGroupEntries"]();
  for (const id of ids) void node["ensureNativeEndpoints"](id);
  await run(5);
  const holders = ids.filter((_, i) => links[i].available.includes("hyperdht/1"));
  expect(holders).toEqual(ids.slice(0, 8));
  const held = new Set(holders.map(id => node["links"].get(id)!.stored.transportSeeds?.["hyperdht/1"]));
  const lost = Date.now();
  relayed.create.mockImplementation(async (seed: string) => {
    if (held.has(seed) && Date.now() - lost < 55_000) throw new Error("The HyperDHT relay did not let this chat listen");
    return fakeEndpoint();
  });
  for (const link of links) for (const endpoint of link.endpoints) endpoint.onUnavailable?.();
  node["retryRelayLater"]();
  const slotsLine = /slots are in use/;
  const errorOf = (id: string) => node.getState().links.find(l => l.id === id)?.transportErrors?.["hyperdht/1"];
  for (let second = 0; second < 90; second++) {
    await run(1);
    for (const id of holders) expect(errorOf(id) ?? "").not.toMatch(slotsLine);
  }
  await run(10 * 60 - 90);
  expect(ids.filter((_, i) => links[i].available.includes("hyperdht/1"))).toEqual(holders);
  for (const id of holders) expect(errorOf(id)).toBeUndefined();
}, 120_000);
