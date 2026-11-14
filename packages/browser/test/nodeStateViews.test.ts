import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, GroupView, StoredLink } from "../src/shared/types";

async function addChat(node: GhostlyNode, label: string) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: Date.now(), label, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  /** The next state the engine pushes. */
  const next = async (): Promise<EngineState> => {
    const before = events.onState.mock.calls.length;
    await vi.waitFor(() => expect(events.onState.mock.calls.length).toBeGreaterThan(before));
    return events.onState.mock.calls.at(-1)![0] as EngineState;
  };
  return { node, next };
}
const view = (state: EngineState, id: string) => state.links.find(link => link.id === id)!;

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

describe("the state a change of one chat pushes", () => {
  it("builds that chat's view again and keeps the same object for every other chat", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice"), b = await addChat(node, "Bob");
    node["emitState"]();
    const first = await next();
    node.renameLink({ linkId: a.id, label: "Alicia" });
    const second = await next();
    expect(view(second, a.id).label).toBe("Alicia");
    expect(view(second, b.id)).toBe(view(first, b.id));
    expect(view(second, a.id)).not.toBe(view(first, a.id));
  });

  it("builds every chat's view again after a change that names no chat, and a chat made again", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice"), b = await addChat(node, "Bob");
    node["emitState"]();
    const first = await next();
    // Changed without a word (as a link's own field may be): a change that names no chat shows it.
    node["links"].get(b.id)!.peerAck = 7;
    node["emitState"]();
    const second = await next();
    expect(view(second, b.id).peerAck).toBe(7);
    expect(view(second, a.id)).not.toBe(view(first, a.id));
    // The same chat's live link made again: its view is built from it, whatever change named another chat.
    node["links"].set(b.id, { ...node["links"].get(b.id)!, peerAck: 9 });
    node.renameLink({ linkId: a.id, label: "Alicia" });
    expect(view(await next(), b.id).peerAck).toBe(9);
  });

  it("builds only the chat a message came to, and no chat for a file's progress", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice"), b = await addChat(node, "Bob");
    node["emitState"]();
    const first = await next();
    await node["storeMessage"]({ linkId: a.id, id: "peer_1", text: "hi", sender: "peer", timestamp: 1_000, via: "datalink" });
    const second = await next();
    expect(view(second, a.id).lastMessageAt).toBeGreaterThan(0);
    expect(view(second, b.id)).toBe(view(first, b.id));
    node["transfers"].set("f1", { id: "f1", linkId: b.id, direction: "in", name: "x", size: 10, mime: "text/plain", transferred: 0, state: "transferring" } as never);
    node["fileProgress"]("f1", 5);
    const third = await next();
    expect(third.transfers.f1.transferred).toBe(5);
    expect(view(third, a.id)).toBe(view(second, a.id));
    expect(view(third, b.id)).toBe(view(second, b.id));
  });

  it("keeps every group's view for a change of a 1:1 chat's own, and builds them again for a contact's name or a group's change", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice");
    let built = 0;
    const group = { id: "g1", profile: "mesh", name: "Ghosts", createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }, { key: "bob", role: "member", nick: "Bob" }] } as unknown as GroupView;
    node["groups"].views = () => { built++; return [group]; };
    node["emitState"]();
    const first = await next();
    built = 0;
    // A message, the contact typing, a delivery mark: nothing a group shows.
    await node["storeMessage"]({ linkId: a.id, id: "peer_1", text: "hi", sender: "peer", timestamp: 1_000, via: "datalink" });
    const second = await next();
    expect(built).toBe(0);
    expect(second.groups[0]).toBe(first.groups[0]);
    // A group's invitation shows its contact's name: a rename builds the groups again.
    node.renameLink({ linkId: a.id, label: "Alicia" });
    const third = await next();
    expect(built).toBe(1);
    expect(third.groups[0]).not.toBe(second.groups[0]);
    // A change that names no chat (a group's own) builds them again too.
    node["emitState"]();
    await next();
    expect(built).toBe(2);
    // And getState reads them fresh.
    node.getState();
    expect(built).toBe(3);
  });

  it("builds again only the group a change names (a message, a member typing, an edge), and keeps the same object for every other group's view", async () => {
    const { node, next } = engine();
    const edge = await addChat(node, "edge");
    const live = node["links"].get(edge.id)!;
    live.stored = { ...live.stored, group: "g1", groupPeer: "bob" };
    const at: Record<string, number> = { g1: 10, g2: 20 };
    const group = (id: string) => ({ id, profile: "mesh", name: id, createdAt: 1, lastMessageAt: at[id], isAdmin: true, canSend: true, invited: [], memberLinks: {},
      members: [{ key: "me", role: "admin", me: true }, { key: "bob", role: "member", nick: "Bob" }] }) as unknown as GroupView;
    let all = 0;
    const one: string[] = [];
    node["groups"].views = () => { all++; return [group("g2"), group("g1")]; };
    node["groups"].view = id => { one.push(id); return group(id); };
    node["emitState"]();
    const first = await next();
    all = 0;
    // A member's message in g1: g1's view built again, and first in the list now; g2's kept.
    at.g1 = 30;
    await node["storeMessage"]({ linkId: "group:g1", id: "m1", text: "hi", sender: "peer", member: "bob", timestamp: 1_000, via: "datalink" });
    const second = await next();
    expect(all).toBe(0);
    expect(one).toEqual(["g1"]);
    expect(second.groups.map(g => g.id)).toEqual(["g1", "g2"]);
    expect(second.groups[1]).toBe(first.groups[0]);
    expect(second.groups[0]!.lastMessageAt).toBe(30);
    // A member typing in g2 (the group's word to the engine): g2 alone.
    node["groups"]["host"].emit(undefined, "g2");
    const third = await next();
    expect(one).toEqual(["g1", "g2"]);
    expect(third.groups[0]).toBe(second.groups[0]);
    expect(third.groups[1]).not.toBe(second.groups[1]);
    // An edge of g1's changed (it came up): g1 alone.
    node["chatChanged"](edge.id);
    const fourth = await next();
    expect(one).toEqual(["g1", "g2", "g1"]);
    expect(fourth.groups[1]).toBe(third.groups[1]);
    // A change that names no group builds them all, as before.
    node["emitState"]();
    await next();
    expect(all).toBe(1);
  });

  it("is read fresh by getState, whatever the last push kept", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice");
    node["emitState"]();
    await next();
    node["links"].get(a.id)!.peerAck = 3;
    expect(view(node.getState(), a.id).peerAck).toBe(3);
  });
});
