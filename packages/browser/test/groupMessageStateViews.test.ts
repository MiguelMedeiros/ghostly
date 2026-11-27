import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, GroupView, StoredLink, StoredMessage } from "../src/shared/types";
// covers: groups.edit, groups.mentions

/**
 * What changes in a group's messages without a new one (a message deleted for everyone, an edit that takes my mention
 * out, a message's whole copy coming after its first one) builds again that group's view alone, as a group's new
 * message does: every 1:1 chat's view and every other group's stay the same objects. Each built every chat's and group's.
 */

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
/** A member's text in group g1. */
const text = (n: number, more: Partial<StoredMessage> = {}): StoredMessage =>
  ({ id: `m${n}`, linkId: "group:g1", text: `hi ${n}`, sender: "peer", member: "bob", timestamp: 1_000 + n, ...more }) as StoredMessage;

const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  const next = async (): Promise<EngineState> => {
    const before = events.onState.mock.calls.length;
    await vi.waitFor(() => expect(events.onState.mock.calls.length).toBeGreaterThan(before));
    for (let seen = -1; seen !== events.onState.mock.calls.length;) { seen = events.onState.mock.calls.length; await new Promise(r => setTimeout(r, 150)); }
    return events.onState.mock.calls.at(-1)![0] as EngineState;
  };
  return { node, next };
}
const chatView = (state: EngineState, id: string) => state.links.find(link => link.id === id)!;
const groupView = (state: EngineState, id: string) => state.groups.find(group => group.id === id)!;

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

describe("the state a change of a group's messages pushes", () => {
  it("builds again only that group's view, and keeps every 1:1 chat's and every other group's", async () => {
    const { node, next } = engine();
    const alice = await add(node, row("Alice")), bob = await add(node, row("Bob"));
    for (let n = 0; n < 3; n++) await db.putMessage(text(n));
    const group = (id: string) => ({ id, profile: "mesh", name: id, createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }] }) as unknown as GroupView;
    let all = 0;
    const one: string[] = [];
    node["groups"].views = () => { all++; return [group("g1"), group("g2")]; };
    node["groups"].view = id => { one.push(id); return group(id); };
    const unmarked: [string, boolean][] = [];
    node["groups"].unmark = async (_groupId, removed, mentionOnly = false) => { unmarked.push([removed.id, mentionOnly]); };
    const host = node["groupEdits"]["host"];
    node["emitState"]();
    let before = await next();
    const changes: [string, () => Promise<unknown>][] = [
      ["a member's message deleted for everyone", () => host.remove("group:g1", "m0")],
      ["my message deleted for everyone", () => host.removeMine("group:g1", text(1, { sender: "me" }), { id: "m1", at: Date.now() } as never)],
      ["an edit that takes my mention out", () => host.unmentioned("group:g1", text(2, { mentioned: true }))],
      ["a message's whole copy, after its first", () => node["completeGroupMessage"](text(2, { mentioned: true }))],
    ];
    for (const [what, change] of changes) {
      all = 0;
      one.length = 0;
      await change();
      const after = await next();
      expect({ what, all }).toEqual({ what, all: 0 });
      expect({ what, one: [...new Set(one)] }).toEqual({ what, one: ["g1"] });
      expect(chatView(after, alice.id), what).toBe(chatView(before, alice.id));
      expect(chatView(after, bob.id), what).toBe(chatView(before, bob.id));
      expect(groupView(after, "g2"), what).toBe(groupView(before, "g2"));
      expect(groupView(after, "g1"), what).not.toBe(groupView(before, "g1"));
      before = after;
    }
    expect(unmarked).toEqual([["m1", false], ["m2", true]]);
    expect(await db.getMessage("group:g1", "m0")).toBeFalsy();
    expect((await db.getMessage("group:g1", "m2"))?.mentioned).toBe(true);
  });
});
