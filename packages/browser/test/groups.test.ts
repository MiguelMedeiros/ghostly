import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAREWELL_KEPT_MS, FAREWELL_OPEN_MS, Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { createIdentity, encodeGroupEntryLink, decodeGroupEntryLink, knockIdentity, readKnocks, identityFromSeedB64, randomBytes, toBase64Url, type GhostRecord, type GroupState } from "@ghostly/core";
import type { StoredGroup, StoredMessage } from "../src/shared/types";
// covers: groups.picture.set, groups.rename, groups.create, groups.invite, groups.send, groups.leave, groups.forget, groups.link.enable, groups.link.join, groups.link.replace, groups.protocol.entry, groups.protocol.mentions

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
  readonly peers = new Map<string, { groups: Groups; messages: StoredMessage[]; edges: Map<string, { peer: string; state: GroupState; open: boolean; expectPeer?: boolean }>; entries: Map<string, Entry>; store: GroupStore }>();
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
    const edges = new Map<string, { peer: string; state: GroupState; open: boolean; expectPeer?: boolean }>();
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
      openEdge: async (state, peer, expectPeer) => { const id = `edge:${name}:${peer.slice(0, 6)}`; edges.set(id, { peer, state, open: true, expectPeer }); return id; },
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
    const groupId = await alice.create("Ghosts", "mesh");
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
    const first = await alice.send(groupId, "hello bob");
    expect(first).toEqual({ error: null, messageId: expect.any(String) });
    expect(await bob.send(groupId, "hello alice")).toEqual({ error: null, messageId: expect.any(String) });
    await world.settle();
    expect(world.texts("alice")).toEqual(["hello bob", "hello alice"]);
    expect(world.texts("bob")).toEqual(["hello bob", "hello alice"]);
    expect((await alice.messages(groupId)).filter(m => !m.event).map(m => m.sender)).toEqual(["me", "peer"]);
    // The id send answers is the one both sides keep the message under (what replies and reactions name).
    for (const side of [alice, bob]) expect((await side.messages(groupId)).find(m => m.id === first.messageId)?.text).toBe("hello bob");

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
    const groupId = await alice.create("Ghosts", "mesh");
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
    const groupId = await alice.create("Ghosts", "mesh");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    const again = new Groups({ ...(bob as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("bob")!.store);
    await again.load();
    expect(again.views()[0]).toMatchObject({ id: groupId, status: "active", epoch: 1 });
    expect((await again.messages(groupId)).map(m => m.event)).toEqual(["joined"]);
  });
  it("what makes a group unread: another member's message, never mine nor a membership line, also after a restart", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load();
    const groupId = await alice.create("Ghosts", "mesh");
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set((g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(v.id)!.state.seedB64, v.myKey); };
    record(alice);
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    record(bob);
    await world.settle();
    await world.meet();
    await alice.send(groupId, "hello", []);
    await world.settle();
    const sent = world.peers.get("alice")!.messages.find(m => !m.event)!;
    // Mine moves the group in the list, and is not unread; on Bob's side it is.
    expect(alice.views()[0].lastMessageAt).toBe(sent.timestamp);
    expect(alice.views()[0].lastPeerMessageAt ?? 0).toBe(0);
    // While the app runs, from when it came (here, as it was sent); a restart reads its time back from the history.
    expect(bob.views()[0].lastPeerMessageAt).toBeGreaterThanOrEqual(world.peers.get("bob")!.messages.find(m => !m.event)!.timestamp);
    expect(bob.views()[0].lastPeerMessageAt).toBeLessThanOrEqual(Date.now());
    // A membership line after it (never unread while the app runs) is not unread after a restart either.
    world.peers.get("alice")!.messages.push({ linkId: `group:${groupId}`, id: "event:1:joined:later", text: "Carol joined", sender: "peer", event: "joined", timestamp: sent.timestamp + 60_000, via: "datalink" });
    const again = new Groups({ ...(alice as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("alice")!.store);
    await again.load();
    expect(again.views()[0].lastMessageAt).toBe(sent.timestamp);
    expect(again.views()[0].lastPeerMessageAt ?? 0).toBe(0);
  });

  it("mentions: kept with the message, flagged on the side they name, in the list's view and after a restart", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load();
    const groupId = await alice.create("Ghosts", "mesh");
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set((g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(v.id)!.state.seedB64, v.myKey); };
    record(alice);
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    record(bob);
    await world.settle();
    await world.meet();
    const bobKey = bob.views()[0].myKey!;
    const mentions = [{ k: bobKey, o: 0, l: 4 }];
    expect(await alice.send(groupId, "@Bob look", mentions)).toEqual({ error: null, messageId: expect.any(String) });
    expect(await alice.send(groupId, "no one", [])).toEqual({ error: null, messageId: expect.any(String) });
    await world.settle();
    const onBob = world.peers.get("bob")!.messages.filter(m => !m.event);
    expect(onBob.map(m => [m.text, m.mentions, m.mentioned])).toEqual([["@Bob look", mentions, true], ["no one", undefined, undefined]]);
    // The sender keeps the mentions to draw them, and is not "mentioned" by its own message.
    const onAlice = world.peers.get("alice")!.messages.filter(m => !m.event);
    expect(onAlice.map(m => [m.mentions, m.mentioned])).toEqual([[mentions, undefined], [undefined, undefined]]);
    expect(bob.views()[0].lastMentionAt).toBeGreaterThanOrEqual(onBob[0].timestamp);
    expect(bob.views()[0].lastMentionAt).toBeLessThanOrEqual(Date.now());
    expect(alice.views()[0].lastMentionAt).toBeUndefined();
    // After a restart it is what it was: when the mention came, not only when it was written.
    const before = bob.views()[0].lastMentionAt;
    const again = new Groups({ ...(bob as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("bob")!.store);
    await again.load();
    expect(again.views()[0].lastMentionAt).toBe(before);
  });

  it("a stranger joins through the group's link: knocks, is admitted over an entry session, then meets everyone on edges", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load(); await carol.load();
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const stateOf = (g: Groups, id: string): GroupState => (g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(id)!.state;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set(stateOf(g, v.id).seedB64, v.myKey); };
    const groupId = await alice.create("Ghosts", "mesh");
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
    // The joiner is told how far it got, and only what it knows: its knock is there to be read…
    await vi.waitFor(() => expect(carol.views()[0].invitation!.stage).toBe("knocked"));
    expect(world.pkarr.size).toBe(1); // the knock

    await alice.tick(); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(1);
    // …the admin's app opened the entry session…
    expect(carol.views()[0].invitation!.stage).toBe("answered");
    await world.meetEntries();
    record(carol);
    expect(carol.views()[0]).toMatchObject({ name: "Ghosts", status: "active", epoch: 2 });
    expect(carol.views()[0].members).toHaveLength(3);
    expect(world.events("carol")).toEqual(["joined"]);
    // The joiner keeps the entry session until its edge to the admin is up (the admin says what it commits next over
    // it); it is not a contact of the group.
    expect(world.peers.get("carol")!.entries.size).toBe(1);
    expect(alice.views()[0].memberLinks).toEqual({ "chat-ab": bob.views()[0].myKey });
    expect(alice.views()[0].invited).toEqual([]);

    await world.settle(); await world.meet(); await world.settle();
    expect(world.peers.get("carol")!.entries.size).toBe(0);
    // An admin and the member it admits were both here a moment ago: the edge between them looks fast for
    // the other side (Bob's to Alice from his own admission too); the one between the two members does not.
    const expecting = (who: string) => [...world.peers.get(who)!.edges.values()].filter(e => e.expectPeer).map(e => e.peer).sort();
    const [aliceKey, bobKey, carolKey] = [alice, bob, carol].map(g => g.views()[0].myKey!);
    expect(expecting("carol")).toEqual([aliceKey]);
    expect(expecting("alice")).toEqual([bobKey, carolKey].sort());
    expect(expecting("bob")).toEqual([aliceKey]);
    expect(await carol.send(groupId, "hi from a stranger")).toEqual({ error: null, messageId: expect.any(String) });
    await world.settle();
    expect(world.texts("alice")).toContain("hi from a stranger");
    expect(world.texts("bob")).toContain("hi from a stranger");

    // A knock seen again later is not answered twice: that key is a member now.
    await alice.tick(Date.now() + 10_000); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(1); // only the lingering one
  });

  it("the admin's picture reaches every member, and a stranger who joins by the link later; members cannot set it", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    world.chats.set("chat-ab", ["alice", "bob"]);
    await alice.load(); await bob.load(); await carol.load();
    const keys = (globalThis as unknown as { __keys: Map<string, string> }).__keys;
    const stateOf = (g: Groups, id: string): GroupState => (g as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(id)!.state;
    const record = (g: Groups) => { for (const v of g.views()) if (v.myKey) keys.set(stateOf(g, v.id).seedB64, v.myKey); };
    const pic = (fill: number) => "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0x00, 0x02, fill, 0xff, 0xd9));
    const groupId = await alice.create("Ghosts", "mesh");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId); await world.settle();
    record(alice); record(bob);
    await world.settle(); await world.meet();

    await expect(bob.setPicture(groupId, pic(1))).rejects.toThrow("Only the admin");
    await alice.setPicture(groupId, pic(1)); await world.settle();
    expect(alice.views()[0].picture).toBe(pic(1));
    expect(bob.views()[0].picture).toBe(pic(1));
    expect(world.peers.get("bob")!.messages.filter(m => m.event === "picture").map(m => m.member)).toEqual([alice.views()[0].myKey]);

    // Carol joins by the link: the picture comes with the first sync on her edges.
    const code = await alice.enableLink(groupId);
    await carol.joinByLink(code);
    await vi.waitFor(() => expect(carol.views()[0].invitation!.stage).toBe("knocked"));
    await alice.tick(); await world.settle();
    await world.meetEntries();
    record(carol);
    await world.settle(); await world.meet();
    expect(carol.views()[0]).toMatchObject({ status: "active", picture: pic(1) });
    // The picture she got in with is no change made while she was a member: no line says Alice changed it.
    expect(world.peers.get("carol")!.messages.filter(m => m.event === "picture")).toEqual([]);

    await alice.setPicture(groupId, null); await world.settle();
    expect([alice, bob, carol].map(g => g.views()[0].picture)).toEqual([undefined, undefined, undefined]);
    expect(world.peers.get("carol")!.messages.filter(m => m.event === "picture").map(m => m.text).at(-1)).toMatch(/removed the group's picture$/);

    // The name, the same way: only the admin, the picture kept, a line for each member.
    await alice.setPicture(groupId, pic(2)); await world.settle();
    await expect(bob.rename(groupId, "Bob's")).rejects.toThrow("Only the admin");
    await alice.rename(groupId, "Book\nclub"); await world.settle();
    expect([alice, bob, carol].map(g => [g.views()[0].name, g.views()[0].picture])).toEqual([["Book club", pic(2)], ["Book club", pic(2)], ["Book club", pic(2)]]);
    expect(world.peers.get("alice")!.messages.filter(m => m.event === "renamed").map(m => m.text)).toEqual(["You renamed the group to “Book club”"]);
    expect(world.peers.get("carol")!.messages.filter(m => m.event === "renamed").map(m => m.member)).toEqual([alice.views()[0].myKey]);
  });

  it("a knock another joiner's write replaced goes again within moments, and one still there is not rewritten", async () => {
    const world = new World();
    const alice = world.add("alice"), carol = world.add("carol"), dave = world.add("dave");
    await alice.load(); await carol.load(); await dave.load();
    const groupId = await alice.create("Ghosts", "mesh");
    const code = await alice.enableLink(groupId);
    const link = decodeGroupEntryLink(code)!;
    const knockKey = knockIdentity(link).pubKeyZ32;
    const knocks = () => readKnocks(link, world.pkarr.get(knockKey) ?? []).map(k => k.key).sort();
    const keyOf = (g: Groups) => identityFromSeedB64((g as unknown as { stored: Map<string, StoredGroup> }).stored.get(groupId)!.invitation!.seedB64!).pubKeyZ32;
    await carol.joinByLink(code);
    await vi.waitFor(() => expect(knocks()).toHaveLength(1));
    const carolOnly = world.pkarr.get(knockKey)!;
    await dave.joinByLink(code);
    await vi.waitFor(() => expect(knocks()).toHaveLength(2));
    // As when both open the link at the same moment: each read the record without the other's knock, and Carol's write landed last.
    world.pkarr.set(knockKey, carolOnly);
    expect(knocks()).toEqual([keyOf(carol)]);
    const writes = vi.spyOn(world.pkarr, "set");
    const t0 = Date.now();
    // Dave reads his knock back within moments and finds it gone: it goes again, beside Carol's.
    await dave.tick(t0 + 1_600);
    expect(knocks()).toEqual([keyOf(carol), keyOf(dave)].sort());
    expect(writes).toHaveBeenCalledTimes(1);
    // Carol's is there: read back, and not written again while it is fresh. Dave's neither.
    await carol.tick(t0 + 1_600); await carol.tick(t0 + 5_100); await carol.tick(t0 + 10_200); await dave.tick(t0 + 10_200);
    expect(writes).toHaveBeenCalledTimes(1);
    // Past the refresh age it is written again: the admin's app answers only fresh knocks.
    await carol.tick(t0 + 31_000);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(knocks()).toEqual([keyOf(carol), keyOf(dave)].sort());
  });

  it("a relay that keeps answering with the record from before the write is not written to every second", async () => {
    const world = new World();
    const alice = world.add("alice"), carol = world.add("carol");
    await alice.load(); await carol.load();
    const groupId = await alice.create("Ghosts", "mesh");
    const code = await alice.enableLink(groupId);
    const link = decodeGroupEntryLink(code)!, knockKey = knockIdentity(link).pubKeyZ32;
    // What the relay answers reads with, whatever is written: the record as it was, with no knock in it.
    const writes = vi.spyOn(world.pkarr, "set").mockImplementation(() => world.pkarr);
    await carol.joinByLink(code);
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(readKnocks(link, world.pkarr.get(knockKey) ?? [])).toEqual([]);
    const t0 = Date.now();
    // Read back twice in quick succession and written again each time (1.6 s, 3.2 s); from then on at the knock's own
    // pace, every five seconds as before: 9.6 s, 16 s, 22.4 s, 28.8 s. Read back every time, it would be twenty writes.
    for (let s = 1; s <= 20; s++) await carol.tick(t0 + s * 1_600);
    expect(writes).toHaveBeenCalledTimes(7);
  });

  it("tells the joiner how far a join through a link got: knocking, knocked, answered, admitted", async () => {
    let publish!: () => void;
    let seen = false, ready = false;
    const host: GroupsHost = {
      sendOnLink: vi.fn(), linkReady: () => ready, linkSeen: () => seen, contactName: () => undefined, edges: () => new Map(), openEdge: vi.fn(),
      closeEdge: vi.fn(async () => {}), edgeNick: () => undefined, openEntry: vi.fn(async () => "entry-1"), entries: () => new Map(),
      publish: vi.fn(() => new Promise<void>(resolve => { publish = resolve; })), resolve: vi.fn(async () => null), storeMessage: vi.fn(async () => {}), emit: vi.fn(),
    };
    const carol = new Groups(host, memoryStore([]));
    const g = toBase64Url(randomBytes(16)), admin = createIdentity().pubKeyZ32;
    await carol.joinByLink(encodeGroupEntryLink({ g, host: createIdentity().pubKeyZ32 }));
    const stage = () => carol.views()[0].invitation!.stage;
    expect(stage()).toBe("knocking");
    await vi.waitFor(() => expect(host.publish).toHaveBeenCalled());
    const emits = vi.mocked(host.emit).mock.calls.length;
    publish();
    await vi.waitFor(() => expect(stage()).toBe("knocked"));
    expect(host.emit).toHaveBeenCalledTimes(emits + 1); // the app hears it
    seen = true; // the admin's side of the entry session is here
    expect(stage()).toBe("answered");
    seen = false; ready = true;
    expect(stage()).toBe("answered");
    await carol.handleContactFrame("entry-1", { t: "group-invite", g, admin, name: "Ghosts", e: 1, n: 2 });
    expect(stage()).toBe("admitted");
    expect(host.sendOnLink).toHaveBeenCalledWith("entry-1", expect.objectContaining({ t: "group-accept", g }));
  });

  it("a replaced or turned-off link reaches nobody, and the admin role going away turns it off", async () => {
    const world = new World();
    const alice = world.add("alice"), dave = world.add("dave"), erin = world.add("erin");
    await alice.load(); await dave.load(); await erin.load();
    const groupId = await alice.create("Ghosts", "mesh");
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
    const groupId = await alice.create("Ghosts", "mesh");
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
    const groupId = await alice.create("Ghosts", "mesh");
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
      const groupId = await alice.create("Ghosts", "mesh");
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
      expect(await carol.send(groupId, "still here")).toEqual({ error: null, messageId: expect.any(String) });
      await world.settle();
      expect(world.texts("bob")).toContain("still here");
    });

    it("the admin cannot leave when nobody is online to take over, and a group of one simply goes", async () => {
      const { world, alice, bob, carol, groupId, edge } = await trio();
      edge("alice", bob, false); edge("alice", carol, false);
      await expect(alice.leave(groupId)).rejects.toThrow(/nobody else in the group is online/);
      expect(alice.views()[0]).toMatchObject({ status: "active", isAdmin: true });

      const solo = await alice.create("Just me", "mesh");
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

    it("a membership line is written once: a name or a secret arriving later does not write the admin's line again", async () => {
      const { world, alice, bob, carol, groupId, key } = await trio();
      await alice.makeAdmin(groupId, key(bob)); await world.settle();
      const lines = (name: string) => world.peers.get(name)!.messages.filter(m => m.event === "admin").length;
      for (const name of ["alice", "bob", "carol"]) expect(lines(name)).toBe(1);
      // Carol hears a new name for Alice (a nick on an edge), then the same for Bob: each is a change of the session.
      carol.edgeNick(groupId, key(alice), "Alice again"); await world.settle();
      carol.edgeNick(groupId, key(bob), "Bob again"); await world.settle();
      bob.edgeNick(groupId, key(carol), "Carol again"); await world.settle();
      for (const name of ["alice", "bob", "carol"]) expect(lines(name)).toBe(1);
      // A restart reads the chain again: still one line.
      const again = new Groups({ ...(carol as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("carol")!.store);
      await again.load(); await world.settle();
      again.edgeNick(groupId, key(alice), "Alice once more"); await world.settle();
      expect(lines("carol")).toBe(1);
    });

    it("a member back after a while reads the lines where they happened, not after everything it missed", async () => {
      const { world, alice, bob, carol, groupId, edge } = await trio();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t0 = Date.now();
        // Carol is away from both.
        edge("alice", carol, false); edge("bob", carol, false);
        vi.setSystemTime(t0 + 60_000);
        await alice.rename(groupId, "Spirits"); await world.settle();
        vi.setSystemTime(t0 + 120_000);
        await alice.send(groupId, "after the name"); await world.settle();
        vi.setSystemTime(t0 + 180_000);
        await alice.rotate(groupId); await world.settle();
        vi.setSystemTime(t0 + 240_000);
        await bob.send(groupId, "after the keys"); await world.settle();
        // An hour later Carol is back: what she reads is in the order it happened.
        vi.setSystemTime(t0 + 3_600_000);
        edge("alice", carol, true); edge("bob", carol, true);
        await world.meet(); await world.settle();
        const timeline = (await carol.messages(groupId)).filter(m => m.event !== "joined").map(m => m.event ?? m.text);
        expect(timeline).toEqual(["renamed", "after the name", "rotated", "after the keys"]);
        const at = (event: string) => world.peers.get("carol")!.messages.find(m => m.event === event)!.timestamp;
        expect(at("renamed")).toBe(t0 + 60_000);
        expect(at("rotated")).toBe(t0 + 180_000);
      } finally { vi.useRealTimers(); }
    });

    describe("a member removed while it is away", () => {
      const edgesOf = (world: World, name: string) => [...world.peers.get(name)!.edges.values()].map(e => e.peer);
      const farewells = async (world: World, name: string) => (await world.peers.get(name)!.store.getGroups())[0].farewells;

      it("learns it when it is back: the admin keeps the edge to it and says so, and nothing else goes over it", async () => {
        const { world, alice, bob, carol, groupId, key, edge } = await trio();
        const bobKey = key(bob);
        // Bob's app is closed, and nothing else reaches him (no contact chat: he could have come through the link).
        edge("alice", bob, false); edge("carol", bob, false);
        world.chats.delete("chat-ab");
        await alice.remove(groupId, bobKey); await world.settle();
        expect(alice.views()[0].members.map(m => m.key)).not.toContain(bobKey);
        expect(carol.views()[0].members.map(m => m.key)).not.toContain(bobKey);
        // Bob does not know yet. The admin waits for him on its edge; Carol has closed hers.
        expect(bob.views()[0]).toMatchObject({ status: "active" });
        expect(edgesOf(world, "alice")).toContain(bobKey);
        expect(edgesOf(world, "carol")).not.toContain(bobKey);
        expect(await farewells(world, "alice")).toMatchObject({ [bobKey]: { e: 3 } });
        await alice.send(groupId, "after bob"); await world.settle();

        // Bob is back: the admin's edge opens, and the commit that removed him goes over it.
        edge("alice", bob, true);
        await world.meet(); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed", canSend: false });
        expect(world.events("bob")).toContain("removed");
        expect(world.texts("bob")).not.toContain("after bob");
        expect(await bob.send(groupId, "anyone?")).toMatchObject({ error: "You were removed from this group" });
        // What Bob still says on that edge is not heard: he is out of the group.
        await alice.handleEdgeFrame(groupId, bobKey, { t: "group-typing", g: groupId, on: true }); await world.settle();
        expect(alice.views()[0].typing).toBeUndefined();
        // A moment later the edge goes, and nothing more is kept about him.
        await alice.tick(Date.now() + 16_000); await world.settle();
        expect(edgesOf(world, "alice")).not.toContain(bobKey);
        expect(await farewells(world, "alice")).toBeUndefined();
      });

      it("that was behind on the chain gets the commits between, with no secret", async () => {
        const { world, alice, bob, groupId, key, edge } = await trio();
        const bobKey = key(bob);
        edge("alice", bob, false); edge("carol", bob, false);
        world.chats.delete("chat-ab");
        // A change Bob missed, then his removal.
        await alice.rotate(groupId); await world.settle();
        await alice.remove(groupId, bobKey); await world.settle();
        const sent: unknown[] = [];
        const host = (alice as unknown as { host: GroupsHost }).host, send = host.sendOnLink.bind(host);
        host.sendOnLink = (linkId, frame) => { if (linkId.includes(bobKey.slice(0, 6))) sent.push(frame); send(linkId, frame); };
        edge("alice", bob, true);
        await world.meet(); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed" });
        // Commits only, and none carries a secret.
        expect(sent.length).toBeGreaterThan(1);
        expect(sent.every(f => (f as { t: string }).t === "group-commit" && !("secret" in (f as object)))).toBe(true);
      });

      it("is still told after the admin's app restarts, and is given up after a week", async () => {
        const { world, alice, bob, carol, groupId, key, edge, known } = await trio();
        const bobKey = key(bob), carolKey = key(carol);
        edge("alice", bob, false); edge("carol", bob, false); edge("alice", carol, false); edge("bob", carol, false);
        world.chats.delete("chat-ab"); world.chats.delete("chat-ac");
        await alice.remove(groupId, bobKey); await alice.remove(groupId, carolKey); await world.settle();
        const again = new Groups({ ...(alice as unknown as { host: GroupsHost }).host, emit: vi.fn() }, world.peers.get("alice")!.store);
        await again.load(); await world.settle();
        world.peers.get("alice")!.groups = again;
        known.set(again, key(alice));
        expect(edgesOf(world, "alice").sort()).toEqual([bobKey, carolKey].sort());
        edge("alice", bob, true);
        await world.meet(); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed" });
        // Carol never comes back: a week later the admin stops waiting for her.
        await again.tick(Date.now() + 6 * 24 * 60 * 60_000); await world.settle();
        expect(edgesOf(world, "alice")).toEqual([carolKey]);
        await again.tick(Date.now() + 8 * 24 * 60 * 60_000); await world.settle();
        expect(edgesOf(world, "alice")).toEqual([]);
        expect(await farewells(world, "alice")).toBeUndefined();
        expect(carol.views()[0]).toMatchObject({ status: "active" });
      });

      it("that is told at once (its edge is up, or its contact chat is) is not waited for", async () => {
        const { world, alice, bob, carol, groupId, key, edge } = await trio();
        await alice.remove(groupId, key(bob)); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed" });
        expect(await farewells(world, "alice")).toBeUndefined();
        // Carol's edge is down, but the chat that invited her carries the notice.
        edge("alice", carol, false);
        await alice.remove(groupId, key(carol)); await world.settle();
        expect(carol.views()[0]).toMatchObject({ status: "removed" });
        expect(await farewells(world, "alice")).toBeUndefined();
        expect(edgesOf(world, "alice")).toEqual([]);
      });

      it("is still told by the admin that removed it after the role went to someone else, and by nobody else", async () => {
        const { world, alice, bob, carol, groupId, key, edge } = await trio();
        const bobKey = key(bob);
        edge("alice", bob, false); edge("carol", bob, false);
        world.chats.delete("chat-ab");
        await alice.remove(groupId, bobKey); await world.settle();
        await alice.makeAdmin(groupId, key(carol)); await world.settle();
        expect(carol.views()[0]).toMatchObject({ isAdmin: true });
        // The new admin waits for nobody: it did not make that commit. The old one still does.
        expect(edgesOf(world, "carol")).not.toContain(bobKey);
        expect(edgesOf(world, "alice")).toContain(bobKey);
        const sent: { t: string; commit?: { e: number } }[] = [];
        const host = (alice as unknown as { host: GroupsHost }).host, send = host.sendOnLink.bind(host);
        host.sendOnLink = (linkId, frame) => { if (linkId.includes(bobKey.slice(0, 6))) sent.push(frame as { t: string }); send(linkId, frame); };
        edge("alice", bob, true);
        await world.meet(); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed" });
        // The commit that removed it, and not the one after (who the admin is now is no longer its business).
        expect(sent.map(f => [f.t, f.commit?.e])).toEqual([["group-commit", 3]]);
        // What may go over an edge to someone out of the roster: the commits up to its removal. To a member, anything.
        const chain = (alice as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(groupId)!.state.chain;
        expect(chain.map(c => alice.edgeAllows(groupId, bobKey, { t: "group-commit", g: groupId, commit: c }))).toEqual([true, true, true, true, false]);
        expect(alice.edgeAllows(groupId, bobKey, { t: "group-sync", g: groupId, e: 4 })).toBe(false);
        expect(alice.edgeAllows(groupId, createIdentity().pubKeyZ32, { t: "group-commit", g: groupId, commit: chain[0] })).toBe(false);
        expect(alice.edgeAllows(groupId, key(carol), { t: "group-sync", g: groupId, e: 4 })).toBe(true);
      });

      it("invited again before it is back takes the invitation only once it knows, and ends as a member", async () => {
        const { world, alice, bob, groupId, key, edge } = await trio();
        const oldKey = key(bob);
        edge("alice", bob, false); edge("carol", bob, false);
        world.chats.delete("chat-ab");
        await alice.remove(groupId, oldKey); await world.settle();
        // The admin changes its mind while Bob is still away. Bob's app believes it is in the group: it drops the invitation.
        world.chats.set("chat-ab", ["alice", "bob"]);
        await alice.invite(groupId, "chat-ab"); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "active" });
        expect(bob.views()[0].invitation).toBeUndefined();
        // Back: told over the kept edge. The next invitation is taken, under a new member key.
        edge("alice", bob, true);
        await world.meet(); await world.settle();
        expect(bob.views()[0]).toMatchObject({ status: "removed" });
        await alice.invite(groupId, "chat-ab"); await world.settle();
        await bob.accept(groupId); await world.settle();
        // The world finds a peer's edges by its member key: Bob's is a new one.
        (globalThis as unknown as { __keys: Map<string, string> }).__keys.set((bob as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(groupId)!.state.seedB64, bob.views().find(v => v.id === groupId)!.myKey!);
        await world.meet(); await world.settle();
        const again = bob.views().find(v => v.id === groupId)!;
        expect(again).toMatchObject({ status: "active", canSend: true });
        expect(again.myKey).not.toBe(oldKey);
        expect(alice.views()[0].members.map(m => m.key)).toContain(again.myKey);
        expect(alice.views()[0].members.map(m => m.key)).not.toContain(oldKey);
        // The edge kept for the old key goes; the one to the new key is a member's.
        await alice.tick(Date.now() + 16_000); await world.settle();
        expect(await farewells(world, "alice")).toBeUndefined();
        expect(edgesOf(world, "alice")).not.toContain(oldKey);
        expect(edgesOf(world, "alice")).toContain(again.myKey);
        await bob.send(groupId, "back in"); await world.settle();
        expect(world.texts("alice")).toContain("back in");
      });

      it("keeps the edge a minute at most once its connection opened, even to an app that never says where it is", async () => {
        const { world, alice, bob, groupId, key, edge } = await trio();
        const bobKey = key(bob);
        edge("alice", bob, false); edge("carol", bob, false);
        world.chats.delete("chat-ab");
        await alice.remove(groupId, bobKey); await world.settle();
        const t0 = Date.now();
        alice.edgeOpen(groupId, bobKey);
        await alice.tick(t0 + FAREWELL_OPEN_MS - 5_000); await world.settle();
        expect(edgesOf(world, "alice")).toContain(bobKey);
        await alice.tick(t0 + FAREWELL_OPEN_MS + 5_000); await world.settle();
        expect(edgesOf(world, "alice")).not.toContain(bobKey);
        expect(await farewells(world, "alice")).toBeUndefined();
      });

      it("waits for eight members at most, the latest removed, each for a week, on a clock of its own", async () => {
        const { alice, groupId } = await trio();
        const inner = alice as unknown as { stored: Map<string, StoredGroup>; sessions: Map<string, unknown>; tickNow: number;
          noteFarewell(group: StoredGroup, key: string, e: number): void; farewellKeys(group: StoredGroup, session: unknown, now: number): string[] };
        const group = inner.stored.get(groupId)!, session = inner.sessions.get(groupId);
        const t0 = 1_800_000_000_000, keys = Array.from({ length: 10 }, () => createIdentity().pubKeyZ32);
        keys.forEach((k, i) => { inner.tickNow = t0 + i * 1_000; inner.noteFarewell(group, k, 3); });
        // Ten removed while away: the two removed first are no longer waited for.
        expect(Object.keys(group.farewells!).sort()).toEqual(keys.slice(2).sort());
        expect(inner.farewellKeys(group, session, t0 + 9_000).sort()).toEqual(keys.slice(2).sort());
        // A week after each was removed, to the second, it is given up.
        expect(inner.farewellKeys(group, session, t0 + 5_000 + FAREWELL_KEPT_MS).sort()).toEqual(keys.slice(5).sort());
        expect(inner.farewellKeys(group, session, t0 + 5_001 + FAREWELL_KEPT_MS).sort()).toEqual(keys.slice(6).sort());
        expect(inner.farewellKeys(group, session, t0 + 9_001 + FAREWELL_KEPT_MS)).toEqual([]);
        // One told is kept 15 s more, counted from the first time it was told.
        group.farewells![keys[9]].told = t0 + 20_000;
        expect(inner.farewellKeys(group, session, t0 + 34_999)).toContain(keys[9]);
        expect(inner.farewellKeys(group, session, t0 + 35_000)).not.toContain(keys[9]);
        inner.tickNow = 0;
      });
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
