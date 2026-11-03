import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions, type NativeTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: groups.native-links

/**
 * A group's transport, chosen on this device (WISP 902 § Transports): Iroh or HyperDHT runs that one alone on the
 * group's edges and says so in each edge's `_tr`; WebRTC says `["webrtc/1"]`; Automatic is what an edge did before.
 * GhostLink is replaced by a recorder, as in nodeLinks.test.ts: a test plays the member by calling its callbacks.
 */
type Recorded = {
  options: Omit<GhostLinkOptions, "events" | "params"> & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>> };
  availableTransports: string[]; stop: ReturnType<typeof vi.fn>; registerEndpoint: ReturnType<typeof vi.fn>;
};
const links = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = false;
    groupsSupport = false;
    supportsGroupVersion = vi.fn(() => false);
    peerProofAdapters: string[] = [];
    session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
    setChatActive = vi.fn();
    learnPeerTransports = vi.fn();
    registerEndpoint = vi.fn((endpoint: { transport: string }) => { this.availableTransports = [...this.availableTransports, endpoint.transport]; });
    canReleaseEndpoint = vi.fn(() => true);
    releaseEndpoint = vi.fn(async (transport: string) => { this.availableTransports = this.availableTransports.filter((t) => t !== transport); });
    canYieldEndpoint = vi.fn(() => false);
    lastActivityAt = Date.now();
    nativeDescriptors = {};
    relayedTransports: string[] = [];
    start = vi.fn();
    stop = vi.fn(async () => {});
    wake = vi.fn();
    expectPeer = vi.fn();
    depart = vi.fn();
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    setTyping = vi.fn();
    supportsFiles = true;
    canSendText = true;
    textDelivery = "stream";
    peerAllowsPayment = vi.fn(() => false);
    peerChoosesPayment = vi.fn(() => false);
    allowsPayment = vi.fn(() => true);
    // As the real one: WebRTC is listed where the link may use it.
    constructor(readonly options: GhostLinkOptions) { if (options.rtcAvailable === false) this.availableTransports = []; links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
const endpoint = (transport: NativeTransport) => ({ transport, descriptor: transport === "iroh/1" ? { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] } : { publicKey: "cd".repeat(32) },
  connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null });
/** An engine with WebRTC (a browser) that runs Iroh and HyperDHT too, as the CLI does. */
async function engine(natives: NativeTransport[] = ["iroh/1", "hyperdht/1"]) {
  const factories = Object.fromEntries(natives.map((t) => [t, vi.fn(async () => endpoint(t))])) as Record<NativeTransport, ReturnType<typeof vi.fn>>;
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, nativeTransports: factories as never });
  nodes.push(node);
  await node.start();
  return { node, factories };
}
/** A group with one edge, opened by hand; the session's tick is held, or it closes the edge as one nobody asked for. */
async function groupWithEdge(node: GhostlyNode) {
  vi.spyOn(node["groups"], "tick").mockResolvedValue();
  const { groupId } = await node.createGroup({ name: "Plaza" });
  const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
  const edgeId: string = await node["openEdge"](state as never, createIdentity().pubKeyZ32);
  return { groupId, edgeId };
}
const edgeOf = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  links.length = 0;
  vi.stubGlobal("RTCPeerConnection", class {});
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a group's transport chosen on this device (WISP 902 § Transports)", () => {
  it("Automatic is what an edge did before: WebRTC between two apps that have it, no listener, no `_tr`; and back to it after a choice", async () => {
    const { node, factories } = await engine();
    const { groupId, edgeId } = await groupWithEdge(node);
    await settle();
    const first = edgeOf(edgeId);
    expect(first.options).toMatchObject({ rtcAvailable: true, packetTransportsSaid: false, packetTransports: true });
    expect(factories["iroh/1"]).not.toHaveBeenCalled();
    expect(factories["hyperdht/1"]).not.toHaveBeenCalled();

    await node.setGroupTransport({ groupId, transport: "iroh/1" });
    await vi.waitFor(() => expect(edgeOf(edgeId).options.rtcAvailable).toBe(false));
    await node.setGroupTransport({ groupId, transport: "auto" });
    await vi.waitFor(() => expect(edgeOf(edgeId).options.rtcAvailable).toBe(true));
    expect((await db.getSettings()).groupTransports).toBeUndefined();
    // It ran a listener there, so it goes on saying what it runs: `["webrtc/1"]` (as an edge whose WebRTC came back does).
    expect(edgeOf(edgeId).options.packetTransportsSaid).toBe(true);
    await settle();
    expect(edgeOf(edgeId).registerEndpoint).not.toHaveBeenCalled();
  });

  for (const chosen of ["iroh/1", "hyperdht/1"] as const) it(`${chosen} chosen: each edge starts again with no WebRTC and only that listener, and so after a restart`, async () => {
    const { node, factories } = await engine();
    const { groupId, edgeId } = await groupWithEdge(node);
    const before = edgeOf(edgeId);
    await node.setGroupTransport({ groupId, transport: chosen });
    await vi.waitFor(() => expect(edgeOf(edgeId)).not.toBe(before));
    // No goodbye: the member must not take it for a leave.
    expect(before.stop).toHaveBeenCalledWith(false);
    const edge = edgeOf(edgeId);
    expect(edge.options.rtcAvailable).toBe(false);
    await vi.waitFor(() => expect(edge.registerEndpoint).toHaveBeenCalledOnce());
    expect(edge.availableTransports).toEqual([chosen]);
    const other = chosen === "iroh/1" ? "hyperdht/1" : "iroh/1";
    expect(factories[other]).not.toHaveBeenCalled();
    expect((await db.getSettings()).groupTransports).toEqual({ [groupId]: chosen });

    // The member's app runs both (a CLI): the edge live when the app quit resumes on the one chosen, not Iroh first.
    await db.patchLink(edgeId, { edgeLive: true, edgeLiveSince: Date.now(), peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true });
    await node.shutdown();
    nodes.splice(nodes.indexOf(node), 1);
    const again = await engine();
    await vi.waitFor(() => expect(again.factories[chosen]).toHaveBeenCalledOnce());
    expect(edgeOf(edgeId).options).toMatchObject({ rtcAvailable: false, resume: chosen });
    await settle();
    expect(again.factories[other]).not.toHaveBeenCalled();
  });

  it("WebRTC chosen: the edge says `[\"webrtc/1\"]` from its first packet and runs no listener; a member whose `_tr` has no WebRTC is met on a native one", async () => {
    const { node, factories } = await engine();
    const { groupId, edgeId } = await groupWithEdge(node);
    const before = edgeOf(edgeId);
    await node.setGroupTransport({ groupId, transport: "webrtc/1" });
    await vi.waitFor(() => expect(edgeOf(edgeId)).not.toBe(before));
    const edge = edgeOf(edgeId);
    expect(edge.options).toMatchObject({ rtcAvailable: true, packetTransportsSaid: true });
    await settle();
    expect(factories["iroh/1"]).not.toHaveBeenCalled();
    // The member chose Iroh (or its app has no WebRTC): the two meet on Iroh, as before any choice.
    edge.options.events.onPacketTransports(["iroh/1"], { "iroh/1": { id: "ef".repeat(32), relay: null, addresses: [], relayed: true } });
    await vi.waitFor(() => expect(edge.registerEndpoint).toHaveBeenCalled());
    expect(factories["iroh/1"]).toHaveBeenCalledOnce();
  });

  it("two members who chose different native transports meet on the member's too: HyperDHT here, the member's `_tr` says Iroh alone", async () => {
    const { node, factories } = await engine();
    const { groupId, edgeId } = await groupWithEdge(node);
    await node.setGroupTransport({ groupId, transport: "hyperdht/1" });
    await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce());
    const edge = edgeOf(edgeId);
    expect(factories["iroh/1"]).not.toHaveBeenCalled();
    edge.options.events.onPacketTransports(["iroh/1"], { "iroh/1": { id: "ef".repeat(32), relay: null, addresses: [], relayed: true } });
    await vi.waitFor(() => expect(edge.registerEndpoint).toHaveBeenCalledTimes(2));
    expect(edge.availableTransports).toEqual(["hyperdht/1", "iroh/1"]);
    expect(edge.options.rtcAvailable).toBe(false);
  });

  it("a member whose app follows this side's choice (its `_tr` names WebRTC and the one chosen) starts nothing more here", async () => {
    const { node, factories } = await engine();
    const { groupId, edgeId } = await groupWithEdge(node);
    await node.setGroupTransport({ groupId, transport: "hyperdht/1" });
    await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce());
    edgeOf(edgeId).options.events.onPacketTransports(["webrtc/1", "iroh/1", "hyperdht/1"], {});
    await settle();
    expect(factories["iroh/1"]).not.toHaveBeenCalled();
    expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce();
  });

  it("refuses a transport this app does not run, an unknown choice and a group it is not in; the settings cannot write it", async () => {
    const { node } = await engine(["iroh/1"]);
    const { groupId } = await groupWithEdge(node);
    await expect(node.setGroupTransport({ groupId, transport: "hyperdht/1" })).rejects.toThrow("Transport unavailable");
    await expect(node.setGroupTransport({ groupId, transport: "carrier-pigeon" as never })).rejects.toThrow("Transport unavailable");
    await expect(node.setGroupTransport({ groupId: "nope", transport: "iroh/1" })).rejects.toThrow("Group not found");
    vi.unstubAllGlobals();
    await expect(node.setGroupTransport({ groupId, transport: "webrtc/1" })).rejects.toThrow("Transport unavailable");
    vi.stubGlobal("RTCPeerConnection", class {});
    await node.updateSettings({ settings: { groupTransports: { [groupId]: "iroh/1" } } as never });
    expect((await db.getSettings()).groupTransports).toBeUndefined();
  });
});
