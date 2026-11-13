import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: settings.network.relay-only, groups.native-links

/**
 * Hide my IP from contacts (`relayOnly`) where this app's WebRTC does not keep to the relay (`webrtcIgnoresRelayOnly`,
 * the CLI's libdatachannel): its chats and group edges run no WebRTC while it is on, as an app with none. They neither
 * offer nor answer a connection (each made fails before any socket opens), and say no `webrtc/1`. With it off, or where
 * WebRTC keeps to the relay (a browser, the Desktop), nothing changes. The CLI's own, with node-datachannel and a real
 * contact's offer: packages/cli/test/relayOnlyWebrtc.test.ts.
 * GhostLink is replaced by a recorder, as in groupTransportChoice.test.ts.
 */
type Recorded = { options: Omit<GhostLinkOptions, "params"> & { params: StoredLink } };
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
    registerEndpoint = vi.fn();
    canReleaseEndpoint = vi.fn(() => true);
    releaseEndpoint = vi.fn(async () => {});
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
    constructor(readonly options: GhostLinkOptions) { if (options.rtcAvailable === false) this.availableTransports = []; links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const TURN = { urls: "turn:turn.example.org:3478", username: "u", credential: "p" };
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
/** Each WebRTC connection made, by its configuration. */
let made: RTCConfiguration[] = [];

async function engine(webrtcIgnoresRelayOnly: boolean) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() },
    { automaticWallets: false, transport: fixture, ...(webrtcIgnoresRelayOnly && { webrtcIgnoresRelayOnly }) });
  nodes.push(node);
  await node.start();
  return node;
}
/** A group with one edge, opened by hand; the session's tick is held, or it closes the edge as one nobody asked for. */
async function groupWithEdge(node: GhostlyNode) {
  vi.spyOn(node["groups"], "tick").mockResolvedValue();
  const { groupId } = await node.createGroup({ name: "Plaza" });
  const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
  const edgeId: string = await node["openEdge"](state as never, createIdentity().pubKeyZ32);
  return { groupId, edgeId };
}
const latest = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)!;
/** Whether the link's connections go: the one it makes is counted, or it fails. */
const connects = (link: Recorded) => { try { link.options.createPeerConnection(); return true; } catch { return false; } };

beforeEach(async () => {
  links.length = 0;
  made = [];
  vi.stubGlobal("RTCPeerConnection", class { constructor(config: RTCConfiguration) { made.push(config); } });
  await transact([STORES.settings, STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.settings, STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hide my IP from contacts where WebRTC does not keep to the relay", () => {
  it("runs a chat and a group edge with no WebRTC while it is on, and with it again once it is off", async () => {
    const node = await engine(true);
    const { linkId } = await node.createLink();
    const { groupId, edgeId } = await groupWithEdge(node);
    expect(latest(linkId).options.rtcAvailable).toBe(true);
    expect(latest(edgeId).options.rtcAvailable).toBe(true);
    expect(connects(latest(edgeId))).toBe(true);
    made = [];

    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    for (const id of [linkId, edgeId]) {
      await vi.waitFor(() => expect(latest(id).options.rtcAvailable).toBe(false));
      expect(connects(latest(id))).toBe(false);
    }
    expect(made).toEqual([]);
    expect(node.getState().transport.webrtc).toBe(false);
    await expect(node.setGroupTransport({ groupId, transport: "webrtc/1" })).rejects.toThrow("Transport unavailable");

    await node.updateSettings({ settings: { relayOnly: false } });
    for (const id of [linkId, edgeId]) await vi.waitFor(() => expect(latest(id).options.rtcAvailable).toBe(true));
    expect(connects(latest(edgeId))).toBe(true);
    expect(node.getState().transport.webrtc).toBeUndefined();
  });

  it("starts a profile that arrives with it already on (a restore, a move) with no WebRTC for its chats and edges", async () => {
    const node = await engine(true);
    const { linkId } = await node.createLink();
    await groupWithEdge(node);
    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    await node.shutdown();
    nodes.splice(nodes.indexOf(node), 1);
    links.length = 0;
    made = [];

    const again = await engine(true);
    expect(again.getState().settings.relayOnly).toBe(true);
    await vi.waitFor(() => expect(latest(linkId)).toBeDefined());
    vi.spyOn(again["groups"], "tick").mockResolvedValue();
    const state = (await db.getGroups())[0]!.community;
    const edge: string = await again["openEdge"](state as never, createIdentity().pubKeyZ32);
    for (const id of [linkId, edge]) {
      expect(latest(id).options.rtcAvailable).toBe(false);
      expect(connects(latest(id))).toBe(false);
    }
    expect(made).toEqual([]);
  });

  it("changes nothing where WebRTC keeps to the relay: a browser's chats and edges keep it, on the TURN server alone", async () => {
    const node = await engine(false);
    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    const { linkId } = await node.createLink();
    const { edgeId } = await groupWithEdge(node);
    for (const id of [linkId, edgeId]) {
      expect(latest(id).options.rtcAvailable).toBe(true);
      expect(connects(latest(id))).toBe(true);
    }
    expect(made.every((config) => config.iceTransportPolicy === "relay")).toBe(true);
    expect(node.getState().transport.webrtc).toBeUndefined();
  });
});
