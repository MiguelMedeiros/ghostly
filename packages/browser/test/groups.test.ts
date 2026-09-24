import { beforeEach, describe, expect, it, vi } from "vitest";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import type { GroupState } from "@ghostly/core";
import type { StoredGroup, StoredMessage } from "../src/shared/types";

/** One peer's database, in memory. */
function memoryStore(messages: StoredMessage[]): GroupStore {
  const groups = new Map<string, StoredGroup>();
  return {
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async g => { groups.set(g.id, structuredClone(g)); },
    deleteGroup: async id => { groups.delete(id); for (let i = messages.length - 1; i >= 0; i--) if (messages[i].linkId === `group:${id}`) messages.splice(i, 1); },
    getMessages: async linkId => messages.filter(m => m.linkId === linkId).sort((a, b) => a.timestamp - b.timestamp),
  };
}

/**
 * Two peers' group engines, joined by one contact chat and by the edges the
 * engines ask for. Frames are delivered straight to the other side's handler,
 * as the paired links would once both announced groups.
 */
class World {
  readonly peers = new Map<string, { groups: Groups; messages: StoredMessage[]; edges: Map<string, { peer: string; state: GroupState; open: boolean }>; store: GroupStore }>();
  /** contact chat id → [owner, other owner]: the same chat has one id on each side here, for simplicity. */
  readonly chats = new Map<string, [string, string]>();
  private pending: Promise<unknown>[] = [];

  add(name: string): Groups {
    const edges = new Map<string, { peer: string; state: GroupState; open: boolean }>();
    const messages: StoredMessage[] = [];
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const chat = this.chats.get(linkId);
        if (chat) {
          const other = chat[0] === name ? chat[1] : chat[0];
          this.pending.push(this.peers.get(other)!.groups.handleContactFrame(linkId, frame as Record<string, unknown>));
          return;
        }
        const edge = edges.get(linkId);
        if (!edge || !edge.open) throw new Error("edge down");
        const target = [...this.peers.values()].find(p => [...p.edges.values()].some(e => e.state.id === edge.state.id && e.peer === myKey(edge.state)));
        if (!target) throw new Error("nobody there");
        const theirEdge = [...target.edges.entries()].find(([, e]) => e.state.id === edge.state.id && e.peer === myKey(edge.state))!;
        if (!theirEdge[1].open) throw new Error("edge down");
        this.pending.push(target.groups.handleEdgeFrame(edge.state.id, myKey(edge.state), frame));
      },
      linkReady: linkId => this.chats.has(linkId) || !!edges.get(linkId)?.open,
      contactName: linkId => this.chats.has(linkId) ? `contact:${linkId}` : undefined,
      edges: groupId => new Map([...edges.entries()].filter(([, e]) => e.state.id === groupId).map(([id, e]) => [e.peer, id])),
      openEdge: async (state, peer) => { const id = `edge:${name}:${peer.slice(0, 6)}`; edges.set(id, { peer, state, open: true }); return id; },
      closeEdge: async linkId => { edges.delete(linkId); },
      edgeNick: () => undefined,
      storeMessage: async message => { if (!messages.some(m => m.id === message.id)) messages.push(message); },
      emit: () => {},
    };
    const store = memoryStore(messages);
    const groups = new Groups(host, store);
    this.peers.set(name, { groups, messages, edges, store });
    return groups;
  }
  /** Both sides of every open edge introduce themselves, as they do when an edge comes up. */
  async meet(): Promise<void> {
    for (const [name, peer] of this.peers) for (const [linkId, edge] of peer.edges) if (edge.open) {
      peer.groups.edgeReady(edge.state.id, edge.peer, linkId);
      void name;
    }
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 10; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); await new Promise(r => setTimeout(r, 5)); }
  }
  texts(name: string): string[] { return this.peers.get(name)!.messages.filter(m => !m.event).map(m => m.text); }
  events(name: string): string[] { return this.peers.get(name)!.messages.filter(m => m.event).map(m => m.event!); }
}
const myKey = (state: GroupState) => {
  // The engine derives it from the seed; the test only needs the roster entry that is not the peer's.
  return (globalThis as unknown as { __keys: Map<string, string> }).__keys.get(state.seedB64)!;
};

describe("group engine: admission over a contact chat, edges from the roster", () => {
  beforeEach(() => { (globalThis as unknown as { __keys: Map<string, string> }).__keys = new Map(); });

  it("creates, invites, accepts, welcomes, opens edges and carries text; leaving closes them", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load();
    const groupId = await alice.create("Ghosts");
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set(stateOf(g, v.id).seedB64, v.myKey); };
    const stateOf = (g: Groups, id: string): GroupState => (g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(id)!.state;
    record(alice);
    expect(alice.views()[0]).toMatchObject({ name: "Ghosts", isAdmin: true, members: [{ role: "admin", me: true }] });
    expect(world.events("alice")).toEqual(["created"]);

    await alice.invite(groupId, "chat-ab"); await world.settle();
    expect(bob.views()[0].invitation).toMatchObject({ linkId: "chat-ab", contact: "contact:chat-ab", members: 1, accepted: false });
    await bob.accept(groupId); await world.settle();
    record(bob);
    expect(bob.views()[0]).toMatchObject({ status: "active", isAdmin: false, epoch: 1 });
    expect(bob.views()[0].members.map(m => m.role).sort()).toEqual(["admin", "member"]);
    expect(alice.views()[0].invited).toEqual([]);
    expect(world.events("bob")).toEqual(["joined"]);
    expect(world.events("alice")).toEqual(["created", "joined"]);
    // Each side asked for the edge to the other, from the roster alone.
    await world.settle();
    expect(world.peers.get("alice")!.edges.size).toBe(1);
    expect(world.peers.get("bob")!.edges.size).toBe(1);

    await world.meet();
    expect(await alice.send(groupId, "hello bob")).toEqual({ error: null });
    expect(await bob.send(groupId, "hello alice")).toEqual({ error: null });
    await world.settle();
    expect(world.texts("alice")).toEqual(["hello bob", "hello alice"]);
    expect(world.texts("bob")).toEqual(["hello bob", "hello alice"]);
    expect((await alice.messages(groupId)).filter(m => !m.event).map(m => m.sender)).toEqual(["me", "peer"]);

    await bob.leave(groupId); await world.settle();
    expect(bob.views()[0]).toMatchObject({ status: "left" });
    expect(alice.views()[0].members).toHaveLength(1);
    await world.settle();
    expect(world.peers.get("alice")!.edges.size).toBe(0);
    expect(world.peers.get("bob")!.edges.size).toBe(0);
    expect(world.events("alice")).toEqual(["created", "joined", "gone"]);

    // Forgetting removes the group and its history from the device.
    await bob.forget(groupId);
    expect(bob.views()).toEqual([]);
    expect(await bob.messages(groupId)).toEqual([]);
  });

  it("refuses to invite what it cannot: a contact without groups, a member twice, or as a non-admin", async () => {
    const world = new World();
    const alice = world.add("alice");
    await alice.load();
    const groupId = await alice.create("Ghosts");
    await expect(alice.invite(groupId, "chat-nobody")).rejects.toThrow(/updated Ghostly/);
    world.chats.set("chat-ab", ["alice", "bob"]);
    const bob = world.add("bob"); await bob.load();
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    await expect(alice.invite(groupId, "chat-ab")).rejects.toThrow(/already a member/);
    await expect(bob.invite(groupId, "chat-ab")).rejects.toThrow(/Only the admin/);
    await bob.decline(groupId).catch(() => {});
  });

  it("survives a restart: state, edges and history come back from the database", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load();
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    const again = new Groups({ ...(bob as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("bob")!.store);
    await again.load();
    expect(again.views()[0]).toMatchObject({ id: groupId, status: "active", epoch: 1 });
    expect((await again.messages(groupId)).map(m => m.event)).toEqual(["joined"]);
  });
});
