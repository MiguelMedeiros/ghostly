import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, GroupView, StoredLink } from "../src/shared/types";
import { CommunityWorld } from "./communityWorld";

/**
 * What a group's edge says of itself (its member's packet read again, a connection attempt, its data link) and a hub's
 * `group-reach` build again the view of that one group, as a chat's own change does (nodeStateViews.test.ts): every 1:1
 * chat's view and every other group's stay the same objects. GhostLink is replaced by a recorder (as in
 * nativeGone.test.ts): the test plays the edge through its callbacks.
 */

type Recorded = { options: GhostLinkOptions & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>> } };
const recorded = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = false;
    groupsSupport = true;
    identitySupport = false;
    peerProofAdapters: string[] = [];
    relayedTransports: string[] = [];
    nativeDescriptors = {};
    start = vi.fn();
    stop = vi.fn(async () => {});
    expectPeer = vi.fn();
    depart = vi.fn();
    look = vi.fn();
    allowsPayment = vi.fn(() => false);
    peerAllowsPayment = vi.fn(() => false);
    peerChoosesPayment = vi.fn(() => false);
    supportsGroupVersion = vi.fn(() => false);
    paymentEnabled = vi.fn(() => false);
    constructor(readonly options: GhostLinkOptions) { recorded.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

function row(label: string, more: Partial<StoredLink> = {}): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: Date.now(), label, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...more };
}
async function add(node: GhostlyNode, stored: StoredLink) {
  await db.putLink(stored);
  node["links"].set(stored.id, { stored, myPubKeyZ32: "me", link: null, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return stored;
}

const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  const next = async (): Promise<EngineState> => {
    const before = events.onState.mock.calls.length;
    await vi.waitFor(() => expect(events.onState.mock.calls.length).toBeGreaterThan(before));
    return events.onState.mock.calls.at(-1)![0] as EngineState;
  };
  return { node, next };
}
const chatView = (state: EngineState, id: string) => state.links.find(link => link.id === id)!;
const groupView = (state: EngineState, id: string) => state.groups.find(group => group.id === id)!;

beforeEach(async () => {
  recorded.length = 0;
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

describe("the state a group's edge's own change pushes", () => {
  it("builds again only the edge's group, and keeps every 1:1 chat's view and every other group's", async () => {
    const { node, next } = engine();
    const alice = await add(node, row("Alice")), bob = await add(node, row("Bob"));
    const edge = await add(node, row("edge", { group: "g1", groupPeer: createIdentity().pubKeyZ32 }));
    const group = (id: string) => ({ id, profile: "mesh", name: id, createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }] }) as unknown as GroupView;
    let all = 0;
    const one: string[] = [];
    node["groups"].views = () => { all++; return [group("g1"), group("g2")]; };
    node["groups"].view = id => { one.push(id); return group(id); };
    node["startEdge"](edge.id);
    const events = recorded.find(link => link.options.params.id === edge.id)!.options.events;
    node["emitState"]();
    let before = await next();
    all = 0;
    let at = 0;
    const online = () => ({ online: true, lastPacketAt: ++at, services: [] });
    // Each of them, on every member's edge: its packet read again at each republish (every 4 minutes, and on each
    // online or offline flip), each attempt to connect, each drop.
    const changes: [string, () => void][] = [
      ["its member's packet", () => events.onPresence(online())],
      ["its member's packet read again", () => events.onPresence(online())],
      ["a connection attempt", () => events.onPairingState({ status: "connecting" })],
      ["its data link", () => events.onDataLinkState("connecting")],
      ["its data link open", () => events.onDataLinkState("open")],
      ["its status", () => events.onStatus("polling" as never)],
      ["a discovery error", () => events.onDiscoveryError("no relay")],
      ["its member's transports gone", () => events.onPacketTransportsGone()],
      ["its link ready", () => events.onGroupsSupport(true)],
    ];
    for (const [what, change] of changes) {
      one.length = 0;
      change();
      const after = await next();
      expect({ what, all }).toEqual({ what, all: 0 });
      expect({ what, one }).toEqual({ what, one: ["g1"] });
      expect(chatView(after, alice.id), what).toBe(chatView(before, alice.id));
      expect(chatView(after, bob.id), what).toBe(chatView(before, bob.id));
      expect(groupView(after, "g2"), what).toBe(groupView(before, "g2"));
      expect(groupView(after, "g1"), what).not.toBe(groupView(before, "g1"));
      before = after;
    }
  });
});

describe("a hub's `group-reach`", () => {
  it("builds again its group's view when it is taken, and nothing when it is left aside", async () => {
    const world = new CommunityWorld();
    const emits: (string | undefined)[] = [];
    const admin = world.add("admin", () => ({ emit: (_delay?: number, groupId?: string) => { emits.push(groupId); } }));
    const id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const member = world.add("member");
    await member.groups.joinByLink(link);
    await world.until(() => world.member(member, id), 5 * 60_000, 500);
    const adminKey = world.view(admin, id)!.myKey!, memberKey = world.view(member, id)!.myKey!;
    const reach = { t: "group-reach", g: id, k: [adminKey] };
    emits.length = 0;
    await admin.groups.handleEdgeFrame(id, memberKey, structuredClone(reach));
    expect(emits).toEqual([id]);
    // Said again within a second (`REACH_HEARD_MS`): not taken, nothing to show.
    emits.length = 0;
    await admin.groups.handleEdgeFrame(id, memberKey, structuredClone(reach));
    expect(emits).toEqual([]);
  });
});
