import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, RELAY_POLL_INTERVALS, type GhostLinkOptions, type PollIntervals } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology, core.relay-client

/**
 * A community hub's connected edges read Pkarr less often the more of them it holds (`communityEdgeIntervals`), as a
 * private group's edges do as it grows. At a chat's pace (a read a minute per connected edge) an admin carrying 22
 * members spent 22 of the 60 requests a minute the relays allow it on those reads alone, and members a closing hub
 * had cut off waited minutes for the edges it had no requests left to bring up (bug hunt, 2026-11-11).
 */
const links = vi.hoisted(() => [] as { options: GhostLinkOptions & { params: StoredLink } }[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  // GhostLink replaced by a recorder, as in groupTransportChoice.test.ts: only the options an edge starts with matter.
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
    constructor(readonly options: GhostLinkOptions) { links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
const paceOf = (id: string): PollIntervals => links.filter((l) => l.options.params.id === id).at(-1)!.options.pollIntervals!;

beforeEach(async () => {
  links.length = 0;
  vi.stubGlobal("RTCPeerConnection", class {});
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a community hub's connected edges (relays' budget)", () => {
  it("read at a chat's pace up to eight edges in the community, then less often in proportion; every other pace stays", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false, transport: fixture });
    nodes.push(node);
    await node.start();
    // The session's tick is held, or it closes the edges as ones nobody asked for.
    vi.spyOn(node["groups"], "tick").mockResolvedValue();
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.community!;
    const open = (): Promise<string> => node["openEdge"](state as never, createIdentity().pubKeyZ32);
    const first = await open();
    const pace = paceOf(first);
    expect(pace.connected, "one edge: a chat's pace").toBe(RELAY_POLL_INTERVALS.connected);
    for (let i = 1; i < 8; i++) await open();
    expect(pace.connected, "eight edges: still a chat's pace").toBe(RELAY_POLL_INTERVALS.connected);
    for (let i = 8; i < 24; i++) await open();
    // A hub carrying 24: each connected edge every 3 minutes, 8 reads a minute for all of them, not 24.
    expect(pace.connected).toBe(3 * RELAY_POLL_INTERVALS.connected);
    expect(paceOf(first)).toBe(pace);
    expect({ ...pace, connected: 0 }).toEqual({ ...RELAY_POLL_INTERVALS, connected: 0 });
  });
});

describe("a community of 36 on the relays' budget (CommunityWorld)", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("no app reads its connected edges more than about 8 times a minute, however many it carries", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(1));
    restore = sameRun(world, 1);
    const admin = world.add("admin");
    const id = await admin.groups.create("Town");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [];
    for (let i = 1; i < 36; i += 12) {
      const wave = Array.from({ length: Math.min(12, 36 - i) }, (_, k) => world.add(`p${i + k}`));
      for (const p of wave) await p.groups.joinByLink(link);
      peers.push(...wave);
      await world.until(() => wave.every((p) => world.member(p, id)), 20 * 60_000);
    }
    await world.run(2 * 60_000);
    const everyone = [admin, ...peers];
    const upEdges = (p: Peer) => [...p.links.values()].filter((e) => e.kind === "edge" && e.g === id && e.upAt !== undefined).length;
    const busiest = Math.max(...everyone.map(upEdges));
    expect(busiest, "a hub carries more than 8").toBeGreaterThanOrEqual(12);
    const reads = new Map<Peer, number>();
    world.onSpend = (peer, what, cost, ok) => {
      if (ok && what === "edge poll up") reads.set(peer, (reads.get(peer) ?? 0) + cost);
    };
    await world.run(3 * 60_000);
    // About 8 a minute, a little more while edges come and go. At a chat's pace, one a minute per connected edge: as
    // many as the busiest hub carries (17 and 15 of 60 requests a minute for the two busiest, seed 1).
    expect(Math.max(...reads.values()) / 3, `connected reads a minute, the busiest app carrying ${busiest}`).toBeLessThanOrEqual(10);
  });
});
