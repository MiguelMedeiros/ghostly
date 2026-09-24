import { beforeEach, describe, expect, it, vi } from "vitest";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { identityFromSeedB64, type GhostRecord, type GroupState } from "@ghostly/core";
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
interface Entry { g: string; me: string; peer: string; role: "host" | "guest" }

class World {
  readonly peers = new Map<string, { groups: Groups; messages: StoredMessage[]; edges: Map<string, { peer: string; state: GroupState; open: boolean }>; entries: Map<string, Entry>; store: GroupStore }>();
  /** Pkarr, shared: key → records. */
  readonly pkarr = new Map<string, GhostRecord[]>();
  /** contact chat id → [owner, other owner]: the same chat has one id on each side here, for simplicity. */
  readonly chats = new Map<string, [string, string]>();
  private pending: Promise<unknown>[] = [];

  /** The other end of an entry session, when both sides opened it. */
  counterpart(entry: Entry): { name: string; linkId: string } | undefined {
    for (const [name, peer] of this.peers) for (const [linkId, e] of peer.entries) if (e.g === entry.g && e.me === entry.peer && e.peer === entry.me) return { name, linkId };
    return undefined;
  }
  /** Entry sessions whose both ends exist come up: the admin's side hears it. */
  async meetEntries(): Promise<void> {
    for (const peer of this.peers.values()) for (const [linkId, e] of peer.entries) if (e.role === "host" && this.counterpart(e)) peer.groups.entryReady(e.g, linkId, e.peer);
    await this.settle();
  }

  add(name: string): Groups {
    const edges = new Map<string, { peer: string; state: GroupState; open: boolean }>();
    const entries = new Map<string, Entry>();
    const messages: StoredMessage[] = [];
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const chat = this.chats.get(linkId);
        if (chat) {
          const other = chat[0] === name ? chat[1] : chat[0];
          this.pending.push(this.peers.get(other)!.groups.handleContactFrame(linkId, frame as Record<string, unknown>));
          return;
        }
        const entry = entries.get(linkId);
        if (entry) {
          const there = this.counterpart(entry);
          if (!there) throw new Error("entry down");
          this.pending.push(this.peers.get(there.name)!.groups.handleContactFrame(there.linkId, frame as Record<string, unknown>));
          return;
        }
        const edge = edges.get(linkId);
        if (!edge || !edge.open) throw new Error("edge down");
        // The member at the other end: its edge points back at me, and its key is the one mine points at.
        const mine = (e: { peer: string; state: GroupState }) => e.state.id === edge.state.id && e.peer === myKey(edge.state) && myKey(e.state) === edge.peer;
        const target = [...this.peers.values()].find(p => [...p.edges.values()].some(mine));
        if (!target) throw new Error("nobody there");
        const theirEdge = [...target.edges.entries()].find(([, e]) => mine(e))!;
        if (!theirEdge[1].open) throw new Error("edge down");
        this.pending.push(target.groups.handleEdgeFrame(edge.state.id, myKey(edge.state), frame));
      },
      linkReady: linkId => this.chats.has(linkId) || !!edges.get(linkId)?.open || (entries.has(linkId) && !!this.counterpart(entries.get(linkId)!)),
      contactName: linkId => this.chats.has(linkId) ? `contact:${linkId}` : undefined,
      edges: groupId => new Map([...edges.entries()].filter(([, e]) => e.state.id === groupId).map(([id, e]) => [e.peer, id])),
      openEdge: async (state, peer) => { const id = `edge:${name}:${peer.slice(0, 6)}`; edges.set(id, { peer, state, open: true }); return id; },
      closeEdge: async linkId => { edges.delete(linkId); entries.delete(linkId); },
      openEntry: async (link, role, seedB64, peer) => {
        const me = identityFromSeedB64(seedB64).pubKeyZ32, id = `entry:${name}:${peer.slice(0, 6)}`;
        entries.set(id, { g: link.g, me, peer, role });
        return id;
      },
      entries: groupId => new Map([...entries.entries()].filter(([, e]) => e.g === groupId).map(([id, e]) => [e.peer, id])),
      publish: async (identity, records) => { this.pkarr.set(identity.pubKeyZ32, records); },
      resolve: async key => this.pkarr.get(key) ?? null,
      edgeNick: () => undefined,
      storeMessage: async message => { if (!messages.some(m => m.id === message.id)) messages.push(message); },
      emit: () => {},
    };
    const store = memoryStore(messages);
    const groups = new Groups(host, store);
    this.peers.set(name, { groups, messages, edges, entries, store });
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

    // Leaving: the group is gone from Bob's list and history at once; the admin removes him and closes the edges.
    await bob.leave(groupId);
    expect(bob.views()).toEqual([]);
    expect(await bob.messages(groupId)).toEqual([]);
    await world.settle();
    expect(alice.views()[0].members).toHaveLength(1);
    await world.settle();
    expect(world.peers.get("alice")!.edges.size).toBe(0);
    expect(world.peers.get("bob")!.edges.size).toBe(0);
    expect(world.events("alice")).toEqual(["created", "joined", "gone"]);
    // Nothing of it is left on Bob's device once the admin confirmed.
    expect(await world.peers.get("bob")!.store.getGroups()).toEqual([]);
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
  it("a stranger joins through the group's link: knocks, is admitted over an entry session, then meets everyone on edges", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load(); await carol.load();
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const stateOf = (g: Groups, id: string): GroupState => (g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(id)!.state;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set(stateOf(g, v.id).seedB64, v.myKey); };
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    record(alice); record(bob);

    await expect(bob.enableLink(groupId)).rejects.toThrow(/Only the admin/);
    const code = await alice.enableLink(groupId);
    expect(code).toMatch(new RegExp(`^group1/${groupId}/`));
    expect(await alice.enableLink(groupId)).toBe(code); // the same link until it is replaced
    expect(alice.views()[0].entryLink).toBe(code);
    expect(bob.views()[0].entryLink).toBeUndefined();

    // Carol is nobody's contact. Opening the link joins at once: nothing to accept.
    expect(await carol.joinByLink(`https://app.ghostly.tools/#/join/${code}`)).toBe(groupId);
    expect(carol.views()[0]).toMatchObject({ id: groupId, name: "", invitation: { viaLink: true, accepted: true, admin: "" } });
    expect(world.pkarr.size).toBe(1); // the knock

    await alice.tick(); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(1);
    await world.meetEntries();
    record(carol);
    expect(carol.views()[0]).toMatchObject({ name: "Ghosts", status: "active", epoch: 2 });
    expect(carol.views()[0].members).toHaveLength(3);
    expect(world.events("carol")).toEqual(["joined"]);
    // The entry session is closed on the joiner's side at once; it is not a contact of the group.
    expect(world.peers.get("carol")!.entries.size).toBe(0);
    expect(alice.views()[0].memberLinks).toEqual({ "chat-ab": bob.views()[0].myKey });
    expect(alice.views()[0].invited).toEqual([]);

    await world.settle(); await world.meet();
    expect(await carol.send(groupId, "hi from a stranger")).toEqual({ error: null });
    await world.settle();
    expect(world.texts("alice")).toContain("hi from a stranger");
    expect(world.texts("bob")).toContain("hi from a stranger");

    // A knock seen again later is not answered twice: that key is a member now.
    await alice.tick(Date.now() + 10_000); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(1); // only the lingering one
  });

  it("a replaced or turned-off link reaches nobody, and the admin role going away turns it off", async () => {
    const world = new World();
    const alice = world.add("alice"), dave = world.add("dave"), erin = world.add("erin");
    await alice.load(); await dave.load(); await erin.load();
    const groupId = await alice.create("Ghosts");
    const old = await alice.enableLink(groupId);
    const fresh = await alice.enableLink(groupId, true);
    expect(fresh).not.toBe(old);
    await dave.joinByLink(old); await world.settle();
    await alice.tick(); await world.settle();
    // Dave knocked under the old link's identity, which nobody reads any more.
    expect(world.peers.get("alice")!.entries.size).toBe(0);

    await alice.disableLink(groupId);
    expect(alice.views()[0].entryLink).toBeUndefined();
    await erin.joinByLink(fresh);
    await alice.tick(Date.now() + 60_000); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(0);
    expect(erin.views()[0].status).toBeUndefined();

    // Giving up: the joiner cancels, and its entry session and knock state go.
    await erin.forget(groupId);
    expect(erin.views()).toEqual([]);
    expect(world.peers.get("erin")!.entries.size).toBe(0);
  });

  it("refuses a link that is not one, and an accept whose key is not the one that knocked", async () => {
    const world = new World();
    const alice = world.add("alice"), frank = world.add("frank");
    await alice.load(); await frank.load();
    await expect(frank.joinByLink("group1/nope")).rejects.toThrow(/not a link to a group/);
    const groupId = await alice.create("Ghosts");
    const code = await alice.enableLink(groupId);
    await frank.joinByLink(code);
    await alice.tick(); await world.settle();
    const [linkId] = [...world.peers.get("alice")!.entries.keys()];
    alice.entryReady(groupId, linkId, [...world.peers.get("alice")!.entries.values()][0].peer);
    // Invited on that session, someone answering with another member key than the one that knocked is not admitted…
    await alice.handleContactFrame(linkId, { t: "group-accept", g: groupId, key: identityFromSeedB64("A".repeat(43)).pubKeyZ32 });
    expect(alice.views()[0].members).toHaveLength(1);
    // …and the one that knocked still is.
    await world.settle();
    expect(alice.views()[0].members).toHaveLength(2);
    expect(alice.views()[0].members.map(m => m.key)).not.toContain(identityFromSeedB64("A".repeat(43)).pubKeyZ32);
  });

  it("drops the admin's admissions in flight on restart; the joiner keeps its side and knocks again", async () => {
    const world = new World();
    const alice = world.add("alice"), gina = world.add("gina");
    await alice.load(); await gina.load();
    const groupId = await alice.create("Ghosts");
    await gina.joinByLink(await alice.enableLink(groupId));
    await alice.tick(); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(1);
    const again = new Groups({ ...(alice as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("alice")!.store);
    await again.load();
    expect(world.peers.get("alice")!.entries.size).toBe(0);
    const ginaAgain = new Groups({ ...(gina as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("gina")!.store);
    await ginaAgain.load();
    expect(world.peers.get("gina")!.entries.size).toBe(1);
    expect(ginaAgain.views()[0].invitation).toMatchObject({ viaLink: true });
  });

  describe("leaving", () => {
    /** Alice (admin), Bob and Carol, invited from Alice's contacts, with their edges up. */
    async function trio() {
      const world = new World();
      const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
      world.chats.set("chat-ab", ["alice", "bob"]);
      world.chats.set("chat-ac", ["alice", "carol"]);
      await alice.load(); await bob.load(); await carol.load();
      const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
      const stateOf = (g: Groups, id: string): GroupState => (g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(id)!.state;
      const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set(stateOf(g, v.id).seedB64, v.myKey); };
      const groupId = await alice.create("Ghosts");
      await alice.invite(groupId, "chat-ab"); await alice.invite(groupId, "chat-ac"); await world.settle();
      await bob.accept(groupId); await world.settle();
      await carol.accept(groupId); await world.settle();
      record(alice); record(bob); record(carol);
      await world.settle(); await world.meet();
      const known = new Map([alice, bob, carol].map(g => [g, g.views()[0].myKey!]));
      const key = (g: Groups) => known.get(g) ?? g.views()[0].myKey!;
      /** Takes the edge between two members down (or up again) on both sides. */
      const edge = (a: string, b: Groups, open: boolean) => {
        for (const e of world.peers.get(a)!.edges.values()) if (e.peer === key(b)) e.open = open;
        for (const e of [...world.peers.values()].find(p => p.groups === b)!.edges.values()) if (e.peer === key(world.peers.get(a)!.groups)) e.open = open;
      };
      return { world, alice, bob, carol, groupId, key, edge, known };
    }

    it("a member leaving while the admin is away: gone from its list at once, and the admin hears it when they meet", async () => {
      const { world, alice, bob, carol, groupId, key, edge } = await trio();
      const bobKey = key(bob);
      edge("alice", bob, false);
      // The contact chat is down too: nothing can carry the leave now.
      world.chats.delete("chat-ab");
      await bob.leave(groupId); await world.settle();
      expect(bob.views()).toEqual([]);
      expect(await bob.messages(groupId)).toEqual([]);
      // Only the edge to the admin stays, waiting for it; Carol's is closed.
      expect([...world.peers.get("bob")!.edges.values()].map(e => e.peer)).toEqual([key(alice)]);
      expect(alice.views()[0].members.map(m => m.key)).toContain(bobKey);

      edge("alice", bob, true);
      await world.meet(); await world.settle();
      expect(alice.views()[0].members.map(m => m.key)).not.toContain(bobKey);
      expect(carol.views()[0].members.map(m => m.key)).not.toContain(bobKey);
      expect(world.peers.get("bob")!.edges.size).toBe(0);
      expect(await world.peers.get("bob")!.store.getGroups()).toEqual([]);
    });

    it("the admin leaving hands the role to a member who is online, who then removes it", async () => {
      const { world, alice, bob, carol, groupId, key, edge } = await trio();
      const aliceKey = key(alice);
      edge("alice", bob, false);
      expect(alice.successor(groupId)).toBe(key(carol));
      await alice.leave(groupId); await world.settle();
      expect(alice.views()).toEqual([]);
      expect(carol.views()[0]).toMatchObject({ isAdmin: true });
      expect(carol.views()[0].members.map(m => m.key)).not.toContain(aliceKey);
      expect(await world.peers.get("alice")!.store.getGroups()).toEqual([]);
      // Bob, away for all of it, is caught up by Carol when they meet.
      await world.meet(); await world.settle();
      expect(bob.views()[0].members.map(m => [m.key, m.role])).toEqual(carol.views()[0].members.map(m => [m.key, m.role]));
      expect(await carol.send(groupId, "still here")).toEqual({ error: null });
      await world.settle();
      expect(world.texts("bob")).toContain("still here");
    });

    it("the admin cannot leave when nobody is online to take over, and a group of one simply goes", async () => {
      const { world, alice, bob, carol, groupId, edge } = await trio();
      edge("alice", bob, false); edge("alice", carol, false);
      await expect(alice.leave(groupId)).rejects.toThrow(/nobody else in the group is online/);
      expect(alice.views()[0]).toMatchObject({ status: "active", isAdmin: true });

      const solo = await alice.create("Just me");
      await alice.leave(solo); await world.settle();
      expect(alice.views().map(v => v.id)).toEqual([groupId]);
      expect(await alice.messages(solo)).toEqual([]);
    });

    it("a leave the admin never hears is forgotten after a week", async () => {
      const { world, alice, bob, groupId, edge } = await trio();
      edge("alice", bob, false);
      world.chats.delete("chat-ab");
      await bob.leave(groupId); await world.settle();
      expect(await world.peers.get("bob")!.store.getGroups()).toHaveLength(1);
      await bob.tick(Date.now() + 6 * 24 * 60 * 60_000);
      expect(await world.peers.get("bob")!.store.getGroups()).toHaveLength(1);
      await bob.tick(Date.now() + 8 * 24 * 60 * 60_000); await world.settle();
      expect(await world.peers.get("bob")!.store.getGroups()).toEqual([]);
      expect(world.peers.get("bob")!.edges.size).toBe(0);
      void alice;
    });

    it("a tombstone survives a restart and still delivers the leave", async () => {
      const { world, alice, bob, groupId, key, edge, known } = await trio();
      const bobKey = key(bob);
      edge("alice", bob, false);
      world.chats.delete("chat-ab");
      await bob.leave(groupId); await world.settle();
      const again = new Groups({ ...(bob as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("bob")!.store);
      await again.load(); await world.settle();
      world.peers.get("bob")!.groups = again;
      known.set(again, key(bob));
      expect(again.views()).toEqual([]);
      edge("alice", again, true);
      await world.meet(); await world.settle();
      expect(alice.views()[0].members.map(m => m.key)).not.toContain(bobKey);
      expect(await world.peers.get("bob")!.store.getGroups()).toEqual([]);
    });
  });
});
