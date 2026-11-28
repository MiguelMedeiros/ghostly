import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, GroupView, StoredLink, StoredMessage } from "../src/shared/types";
// guards: #9003

/**
 * What changes in a 1:1 chat's messages (a delete here or the contact's for everyone, a pin or an unpin, a reaction,
 * either side's, a pinned message's row coming after its pin) and what its DHT delivery says builds again that chat's
 * view alone, as its link's states do (chatLinkStateViews.test.ts): every other chat's view and every group's stay the
 * same objects. So does a compatibility chat's text that the data link delivered. Each built every chat's and group's
 * view. GhostLink is replaced by a recorder.
 */

type Recorded = { isDataLinkOpen: boolean; options: GhostLinkOptions & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>> } };
const recorded = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = false;
    groupsSupport = true;
    identitySupport = false;
    supportsReactions = false;
    supportsPins = false;
    peerProofAdapters: string[] = [];
    relayedTransports: string[] = [];
    nativeDescriptors = {};
    start = vi.fn();
    stop = vi.fn(async () => {});
    expectPeer = vi.fn();
    depart = vi.fn();
    look = vi.fn();
    reactionsPending = vi.fn();
    allowsPayment = vi.fn(() => false);
    peerAllowsPayment = vi.fn(() => false);
    peerChoosesPayment = vi.fn(() => false);
    supportsGroupVersion = vi.fn(() => false);
    paymentEnabled = vi.fn(() => false);
    dhtHolds = vi.fn(() => false);
    // Longer than a state's wait: the text's own state goes before the send ends.
    sendMessage = vi.fn(async () => { await new Promise(r => setTimeout(r, 200)); return null; });
    constructor(readonly options: GhostLinkOptions) { recorded.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

/** `compat`: no profile, a compatibility chat (WISP 402). */
function row(label: string, compat = false): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, ...(!compat && { profile: "paired-chat/1" as const }), createdAt: Date.now(), label, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
}
async function add(node: GhostlyNode, stored: StoredLink) {
  await db.putLink(stored);
  node["links"].set(stored.id, { stored, myPubKeyZ32: "me", link: null, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return stored;
}
/** The contact's text under its wire id (`wire<n>`, eight characters as a wire id takes). */
const text = (linkId: string, n: number): StoredMessage =>
  ({ id: `peer_wire000${n}`, wireId: `wire000${n}`, linkId, text: `hi ${n}`, sender: "peer", timestamp: 1_000 + n, via: "datalink" }) as StoredMessage;

const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  /** The state once this change's last one went: a change's own work goes on after its call returns (`deleteMessage`). */
  const next = async (): Promise<EngineState> => {
    const before = events.onState.mock.calls.length;
    await vi.waitFor(() => expect(events.onState.mock.calls.length).toBeGreaterThan(before));
    for (let seen = -1; seen !== events.onState.mock.calls.length;) { seen = events.onState.mock.calls.length; await new Promise(r => setTimeout(r, 150)); }
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

describe("the state a change of a 1:1 chat's messages pushes", () => {
  it("builds again only that chat's view, and keeps every other chat's and every group's", async () => {
    const { node, next } = engine();
    const alice = await add(node, row("Alice")), bob = await add(node, row("Bob")), old = await add(node, row("Old", true));
    for (let n = 0; n < 7; n++) await db.putMessage(text(bob.id, n));
    const group = { id: "g1", profile: "mesh", name: "g1", createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }] } as unknown as GroupView;
    let all = 0;
    node["groups"].views = () => { all++; return [group]; };
    node["startLink"](bob.id);
    node["startLink"](old.id);
    const events = recorded.find(link => link.options.params.id === bob.id)!.options.events;
    recorded.find(link => link.options.params.id === old.id)!.isDataLinkOpen = true;
    node["emitState"]();
    let before = await next();
    let sent = "";
    // Each change's chat (Bob's unless named), and what its view then shows.
    const changes: [string, () => unknown, (view: EngineState["links"][number]) => unknown, string?][] = [
      ["a delete here", () => node.deleteMessage({ linkId: bob.id, messageId: "peer_wire0000" }), () => undefined],
      ["the contact's delete for everyone", () => events.onMessageEdit({ id: "wire0001", e: 1, rm: true } as never), () => undefined],
      ["my pin", () => node.pinMessage({ linkId: bob.id, messageId: "peer_wire0002" }), view => expect(view.pin?.id).toBe("wire0002")],
      ["the contact's pin", () => events.onPin({ id: "wire0003", n: Date.now() + 60_000 }), view => expect(view.pin?.id).toBe("wire0003")],
      ["the contact's reaction", () => events.onReaction({ id: "wire0004", e: "👍", n: 1 }), view => expect(view.lastReaction?.message).toBe("peer_wire0004")],
      ["my reaction", () => node.react({ linkId: bob.id, messageId: "peer_wire0005", emoji: "🎉" }), view => expect(view.lastReaction?.message).toBe("peer_wire0005")],
      // The chat list's reaction line quotes it: the line goes back to the reaction before.
      ["the reacted message deleted", () => node.deleteMessage({ linkId: bob.id, messageId: "peer_wire0005" }), view => expect(view.lastReaction?.message).toBe("peer_wire0004")],
      ["its DHT delivery", () => events.onDhtDelivery({ peerMode: "dht" } as never), () => undefined],
      // Pinned, then deleted here: the contact's delete for everyone takes the pin (`receiveEdit`'s removed reference).
      ["the contact's pin of a message", () => events.onPin({ id: "wire0006", n: Date.now() + 60_000 }), view => expect(view.pin?.id).toBe("wire0006")],
      ["the pinned message deleted here", () => node.deleteMessage({ linkId: bob.id, messageId: "peer_wire0006" }), view => expect(view.pin?.id).toBe("wire0006")],
      ["its delete for everyone", () => events.onMessageEdit({ id: "wire0006", e: 1, rm: true } as never), view => expect(view.pin?.id).toBe("")],
      // A pin that came before its message names the message once its row is here.
      ["the contact's pin of a message not here yet", () => events.onPin({ id: "wire0007", n: Date.now() + 60_000 }), view => { expect(view.pin?.id).toBe("wire0007"); expect(view.pin?.messageId).toBeUndefined(); }],
      ["the pinned message's row", async () => { await db.putMessage(text(bob.id, 7)); await node["messagesChanged"](bob.id, ["peer_wire0007"]); },
        view => expect(view.pin?.messageId).toBe("peer_wire0007")],
      // A compatibility chat's text sent on the data link is delivered: its own state went while the send took its time.
      ["a compatibility chat's text", async () => { sent = (await node.sendMessage({ linkId: old.id, text: "hello" })).messageId!; },
        view => expect(view.peerAck).toBe(Number(sent.slice("me_".length))), old.id],
    ];
    for (const [what, change, shows, changed = bob.id] of changes) {
      all = 0;
      await change();
      const after = await next();
      expect({ what, all }).toEqual({ what, all: 0 });
      for (const chat of [alice.id, bob.id, old.id].filter(id => id !== changed)) expect(chatView(after, chat), what).toBe(chatView(before, chat));
      expect(after.groups[0], what).toBe(before.groups[0]);
      expect(chatView(after, changed), what).not.toBe(chatView(before, changed));
      shows(chatView(after, changed));
      before = after;
    }
  });
});
