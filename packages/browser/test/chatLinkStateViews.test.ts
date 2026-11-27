import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, GroupView, StoredLink } from "../src/shared/types";
// guards: #8982

/**
 * What a 1:1 chat's link says of itself as it goes live or drops (a connection attempt, its data link, the contact's
 * hold word, its transports) builds again that chat's view alone, as a group's edge does (groupEdgeStateViews.test.ts):
 * every other chat's view and every group's stay the same objects. A daemon or app back, or the relays back, plays each
 * of them on every chat, and each built every chat's and group's view. GhostLink is replaced by a recorder.
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

function row(label: string): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: Date.now(), label, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
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

beforeEach(async () => {
  recorded.length = 0;
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

describe("the state a 1:1 chat's link pushes as it goes live or drops", () => {
  it("builds again only that chat's view, and keeps every other chat's and every group's", async () => {
    const { node, next } = engine();
    const alice = await add(node, row("Alice")), bob = await add(node, row("Bob"));
    const group = { id: "g1", profile: "mesh", name: "g1", createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }] } as unknown as GroupView;
    let all = 0;
    node["groups"].views = () => { all++; return [group]; };
    node["startLink"](bob.id);
    const events = recorded.find(link => link.options.params.id === bob.id)!.options.events;
    node["emitState"]();
    let before = await next();
    // Each of them on every chat when the app or the relays come back, and on each drop.
    const changes: [string, () => unknown][] = [
      ["a connection attempt", () => events.onPairingState({ status: "connecting" })],
      ["its data link", () => events.onDataLinkState("connecting")],
      ["its data link open", () => events.onDataLinkState("open")],
      ["its link ready", () => events.onPairingState({ status: "ready" } as never)],
      ["its session's group frames", () => events.onGroupsSupport(true)],
      ["the contact's hold word", () => events.onHold({ peerAllows: false })],
      ["its data link gone", () => events.onDataLinkState("closed")],
    ];
    for (const [what, change] of changes) {
      all = 0;
      await change();
      const after = await next();
      expect({ what, all }).toEqual({ what, all: 0 });
      expect(chatView(after, alice.id), what).toBe(chatView(before, alice.id));
      expect(after.groups[0], what).toBe(before.groups[0]);
      expect(chatView(after, bob.id), what).not.toBe(chatView(before, bob.id));
      before = after;
    }
  });
});
