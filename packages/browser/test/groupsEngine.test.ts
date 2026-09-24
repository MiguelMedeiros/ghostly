import { afterEach, describe, expect, it, vi } from "vitest";
import { Groups, type EntryTimings, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { createIdentity, identityFromSeedB64, type GhostRecord, type GroupState } from "@ghostly/core";
import type { StoredGroup, StoredMessage } from "../src/shared/types";

/**
 * The group engine's rules beyond the happy path (test/groups.test.ts): who may change the roster,
 * what someone removed can still read, rotation and the admin role, the admission frames it ignores,
 * and the group's link timers (knocks, pending entries, refusals).
 */

function memoryStore(messages: StoredMessage[]): GroupStore & { groups: Map<string, StoredGroup> } {
  const groups = new Map<string, StoredGroup>();
  return {
    groups,
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async g => { groups.set(g.id, structuredClone(g)); },
    deleteGroup: async id => { groups.delete(id); },
    getMessages: async linkId => messages.filter(m => m.linkId === linkId).sort((a, b) => a.timestamp - b.timestamp),
  };
}

const keyOf = (state: GroupState) => identityFromSeedB64(state.seedB64).pubKeyZ32;
interface Edge { peer: string; state: GroupState }
interface Entry { g: string; me: string; peer: string; role: "host" | "guest" }
interface Peer { groups: Groups; messages: StoredMessage[]; edges: Map<string, Edge>; entries: Map<string, Entry>; store: ReturnType<typeof memoryStore>; failEntry: boolean }

/**
 * Peers joined by contact chats and by the edges and entry sessions their engines ask for. Frames are
 * queued, not delivered, until `settle()`: a test can slip something in between.
 */
class World {
  readonly peers = new Map<string, Peer>();
  readonly pkarr = new Map<string, GhostRecord[]>();
  publishes = 0;
  readonly chats = new Map<string, [string, string]>();
  private queue: (() => Promise<unknown>)[] = [];

  private counterpart(entry: Entry): { name: string; linkId: string } | undefined {
    for (const [name, peer] of this.peers) for (const [linkId, e] of peer.entries) if (e.g === entry.g && e.me === entry.peer && e.peer === entry.me) return { name, linkId };
    return undefined;
  }
  async meetEntries(): Promise<void> {
    for (const peer of this.peers.values()) for (const [linkId, e] of peer.entries) if (e.role === "host" && this.counterpart(e)) peer.groups.entryReady(e.g, linkId, e.peer);
    await this.settle();
  }
  add(name: string, timings?: EntryTimings): Groups {
    const peer = { messages: [], edges: new Map(), entries: new Map(), failEntry: false } as unknown as Peer;
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const copy = structuredClone(frame) as Record<string, unknown>;
        const chat = this.chats.get(linkId);
        if (chat) { const other = this.peers.get(chat[0] === name ? chat[1] : chat[0])!; this.queue.push(() => other.groups.handleContactFrame(linkId, copy)); return; }
        const entry = peer.entries.get(linkId);
        if (entry) {
          const there = this.counterpart(entry);
          if (!there) throw new Error("entry down");
          this.queue.push(() => this.peers.get(there.name)!.groups.handleContactFrame(there.linkId, copy));
          return;
        }
        const edge = peer.edges.get(linkId);
        if (!edge) throw new Error("edge down");
        const back = (e: Edge) => e.state.id === edge.state.id && e.peer === keyOf(edge.state) && keyOf(e.state) === edge.peer;
        const target = [...this.peers.values()].find(p => [...p.edges.values()].some(back));
        if (!target) throw new Error("nobody there");
        this.queue.push(() => target.groups.handleEdgeFrame(edge.state.id, keyOf(edge.state), copy));
      },
      linkReady: linkId => this.chats.has(linkId) || peer.edges.has(linkId) || (peer.entries.has(linkId) && !!this.counterpart(peer.entries.get(linkId)!)),
      contactName: linkId => this.chats.has(linkId) ? `contact:${linkId}` : undefined,
      edges: groupId => new Map([...peer.edges.entries()].filter(([, e]) => e.state.id === groupId).map(([id, e]) => [e.peer, id])),
      openEdge: async (state, key) => { const id = `edge:${name}:${key.slice(0, 8)}`; peer.edges.set(id, { peer: key, state }); return id; },
      closeEdge: async linkId => { peer.edges.delete(linkId); peer.entries.delete(linkId); },
      openEntry: async (link, role, seedB64, key) => {
        if (peer.failEntry) throw new Error("no room for a session");
        const id = `entry:${name}:${key.slice(0, 8)}`;
        peer.entries.set(id, { g: link.g, me: identityFromSeedB64(seedB64).pubKeyZ32, peer: key, role });
        return id;
      },
      entries: groupId => new Map([...peer.entries.entries()].filter(([, e]) => e.g === groupId).map(([id, e]) => [e.peer, id])),
      publish: async (identity, records) => { this.publishes++; this.pkarr.set(identity.pubKeyZ32, records); },
      resolve: async key => this.pkarr.get(key) ?? null,
      edgeNick: () => undefined,
      storeMessage: async message => { if (!peer.messages.some(m => m.id === message.id)) peer.messages.push(message); },
      emit: () => {},
    };
    peer.store = memoryStore(peer.messages);
    peer.groups = new Groups(host, peer.store, timings);
    this.peers.set(name, peer);
    return peer.groups;
  }
  /** Both ends of every edge say where they are, as they do when it comes up. */
  async meet(): Promise<void> {
    for (const peer of this.peers.values()) for (const [linkId, edge] of peer.edges) peer.groups.edgeReady(edge.state.id, edge.peer, linkId);
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const batch = this.queue.splice(0);
      await flush();
      if (!batch.length && !this.queue.length) break;
      for (const run of batch) await run();
    }
  }
  texts(name: string): string[] { return this.peers.get(name)!.messages.filter(m => !m.event).map(m => m.text); }
  events(name: string): string[] { return this.peers.get(name)!.messages.filter(m => m.event).map(m => m.event!); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const view = (g: Groups, id?: string) => (id ? g.views().find(v => v.id === id) : g.views()[0])!;

/** Alice's group with Bob (and Carol, when asked) admitted over their contact chats, edges up. */
async function groupOf(names: string[]) {
  const world = new World();
  const alice = world.add("alice");
  const others = names.map(n => { world.chats.set(`chat-a${n[0]}`, ["alice", n]); return world.add(n); });
  for (const g of [alice, ...others]) await g.load();
  const groupId = await alice.create("Ghosts");
  for (const [i, g] of others.entries()) {
    await alice.invite(groupId, `chat-a${names[i][0]}`); await world.settle();
    await g.accept(groupId); await world.settle();
  }
  await world.meet();
  return { world, alice, others, groupId, key: (g: Groups) => view(g, groupId).myKey! };
}

afterEach(() => { vi.useRealTimers(); });

describe("group roster changes: only the admin, and someone removed reads nothing after", () => {
  it("a removed member is told on the admin's chat, loses its edges, and cannot read what is sent next", async () => {
    const { world, alice, others: [bob, carol], groupId, key } = await groupOf(["bob", "carol"]);
    expect(view(carol, groupId).members).toHaveLength(3);
    await alice.remove(groupId, key(carol));
    await world.settle(); await world.meet();
    expect(view(carol, groupId)).toMatchObject({ status: "removed", canSend: false });
    expect(world.events("carol")).toContain("removed");
    expect(world.events("alice")).toContain("gone");
    expect(view(alice, groupId).members.map(m => m.key)).not.toContain(key(carol));
    expect(world.peers.get("carol")!.edges.size).toBe(0);
    expect([...world.peers.get("alice")!.edges.values()].map(e => e.peer)).toEqual([key(bob)]);

    expect(await carol.send(groupId, "still here?")).toEqual({ error: expect.stringMatching(/removed/) });
    expect(await alice.send(groupId, "after carol")).toEqual({ error: null });
    await world.settle();
    expect(world.texts("bob")).toContain("after carol");
    // Even the frame itself, handed to Carol directly, is not read: her secrets went with her membership.
    const frame = (alice as unknown as { sessions: Map<string, { state: GroupState }> }).sessions.get(groupId)!.state.sent.at(-1);
    await carol.handleEdgeFrame(groupId, key(alice), frame);
    expect(world.texts("carol")).not.toContain("after carol");
  });

  it("a removed member whose edges are down learns it from the admin's chat alone", async () => {
    const { world, alice, others: [bob], groupId, key } = await groupOf(["bob"]);
    world.peers.get("bob")!.edges.clear();
    await alice.remove(groupId, key(bob)); await world.settle();
    expect(view(bob, groupId)).toMatchObject({ status: "removed", canSend: false, statusReason: expect.stringMatching(/removed/) });
    expect(world.events("bob")).toContain("removed");
  });

  it("only the admin removes, rotates, hands over the role or invites; nobody removes a stranger", async () => {
    const { alice, others: [bob], groupId, key } = await groupOf(["bob"]);
    await expect(bob.remove(groupId, key(alice))).rejects.toThrow(/Only the admin/);
    await expect(bob.rotate(groupId)).rejects.toThrow(/Only the admin/);
    await expect(bob.makeAdmin(groupId, key(bob))).rejects.toThrow(/Only the admin/);
    await expect(alice.remove(groupId, createIdentity().pubKeyZ32)).rejects.toThrow(/Not a member/);
    await expect(alice.remove("no-such-group", key(bob))).rejects.toThrow(/Group not found/);
    expect(view(alice, groupId).members).toHaveLength(2);
  });

  it("a rotation starts a fresh epoch every member reads, and says so", async () => {
    const { world, alice, others: [bob], groupId } = await groupOf(["bob"]);
    expect(view(bob, groupId).epoch).toBe(1);
    await alice.rotate(groupId); await world.settle();
    expect(view(alice, groupId).epoch).toBe(2);
    expect(view(bob, groupId)).toMatchObject({ epoch: 2, canSend: true });
    expect(world.events("alice")).toContain("rotated");
    expect(world.events("bob")).toContain("rotated");
    expect(await bob.send(groupId, "fresh keys")).toEqual({ error: null });
    await world.settle();
    expect(world.texts("alice")).toContain("fresh keys");
  });

  it("one admin: handing the role over makes the other member the only admin, and the old one a member who can go", async () => {
    const { world, alice, others: [bob], groupId, key } = await groupOf(["bob"]);
    await alice.makeAdmin(groupId, key(bob)); await world.settle();
    expect(view(alice, groupId).isAdmin).toBe(false);
    expect(view(bob, groupId).isAdmin).toBe(true);
    expect(view(bob, groupId).members.filter(m => m.role === "admin").map(m => m.key)).toEqual([key(bob)]);
    const said = world.peers.get("bob")!.messages.filter(m => m.event === "admin").map(m => m.text);
    expect(said).toEqual(["You are now the admin"]);
    await expect(alice.invite(groupId, "chat-ab")).rejects.toThrow(/Only the admin/);
    await alice.leave(groupId); await world.settle();
    expect(alice.views().map(g => g.id)).not.toContain(groupId);
    expect(view(bob, groupId).members.map(m => m.key)).toEqual([key(bob)]);
  });

  it("forgetting an admin's group with members is allowed: everything of it goes, edges included", async () => {
    const { world, alice, groupId } = await groupOf(["bob"]);
    await alice.forget(groupId);
    expect(alice.views()).toEqual([]);
    expect(world.peers.get("alice")!.edges.size).toBe(0);
    expect(world.peers.get("alice")!.store.groups.size).toBe(0);
    expect(await alice.send(groupId, "anyone?")).toEqual({ error: "You are not in this group yet" });
  });
});

describe("invitations: what the admission exchange ignores", () => {
  it("a group holds eight: the eighth invitation while seven are pending is refused", async () => {
    const world = new World();
    const alice = world.add("alice");
    await alice.load();
    const groupId = await alice.create("Ghosts");
    for (let i = 0; i < 7; i++) { world.chats.set(`chat-${i}`, ["alice", `p${i}`]); await world.add(`p${i}`).load(); await alice.invite(groupId, `chat-${i}`); }
    world.chats.set("chat-7", ["alice", "p7"]); world.add("p7");
    await expect(alice.invite(groupId, "chat-7")).rejects.toThrow(/eight members/);
    expect(view(alice).invited).toHaveLength(7);
  });

  it("a declined invitation leaves the admin's pending list, and the invitee keeps nothing", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    expect(view(alice).invited).toEqual(["chat-ab"]);
    await expect(bob.accept("unknown")).rejects.toThrow(/No invitation/);
    await expect(bob.decline("unknown")).rejects.toThrow(/No invitation/);
    expect(await bob.send(groupId, "hi")).toEqual({ error: "You are not in this group yet" });
    await bob.decline(groupId); await world.settle();
    expect(bob.views()).toEqual([]);
    expect(view(alice).invited).toEqual([]);
  });

  it("accepting needs the inviter connected", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    world.chats.delete("chat-ab");
    await expect(bob.accept(groupId)).rejects.toThrow(/not connected/);
    expect(view(bob).invitation!.accepted).toBe(false);
  });

  it("ignores malformed invitations, a second invitation to a group it is in or joining, and more than 32 pending", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    const admin = view(alice).myKey!;
    await bob.handleContactFrame("chat-ab", { t: "group-invite", g: "short", name: "x", admin });
    await bob.handleContactFrame("chat-ab", { t: "group-invite", g: "A".repeat(22), name: "x", admin: "not a key" });
    await bob.handleContactFrame("chat-ab", { t: "group-invite", g: "A".repeat(22), name: 7, admin });
    expect(bob.views()).toEqual([]);

    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId);
    // Accepting: another invitation to the same group, even from someone else, does not replace it.
    const intruder = createIdentity().pubKeyZ32;
    await bob.handleContactFrame("chat-xb", { t: "group-invite", g: groupId, name: "Other", admin: intruder });
    expect(view(bob).invitation).toMatchObject({ linkId: "chat-ab", admin, accepted: true });
    await world.settle();
    expect(view(bob).status).toBe("active");
    await bob.handleContactFrame("chat-xb", { t: "group-invite", g: groupId, name: "Other", admin: intruder });
    expect(view(bob)).toMatchObject({ status: "active", name: "Ghosts" });

    const carol = world.add("carol");
    const id = (i: number) => `${String(i).padStart(2, "0")}${"B".repeat(20)}`;
    for (let i = 0; i < 33; i++) await carol.handleContactFrame("chat-xc", { t: "group-invite", g: id(i), name: `g${i}`, admin: intruder, e: 0, n: 1 });
    expect(carol.views()).toHaveLength(32);
    expect(carol.views().map(v => v.id)).not.toContain(id(32));
    expect(carol.views()[0].invitation).toMatchObject({ admin: intruder, members: 1 });
  });

  it("an accept from a chat that was not invited, or with a malformed key, admits nobody", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    await alice.handleContactFrame("chat-ab", { t: "group-accept", g: groupId, key: createIdentity().pubKeyZ32 });
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await alice.handleContactFrame("chat-ab", { t: "group-accept", g: groupId, key: "nope" });
    await world.settle();
    expect(view(alice).members).toHaveLength(1);
    void bob;
  });

  it("chain pieces from another chat or beyond the limit, and a broken welcome, do not spoil the real welcome", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId);
    // The accept is on its way; before the welcome comes back, junk arrives.
    await bob.handleContactFrame("chat-xb", { t: "group-chain", g: groupId, commits: [{ junk: true }] });
    await bob.handleContactFrame("chat-ab", { t: "group-chain", g: groupId, commits: Array.from({ length: 1025 }, () => ({ junk: true })) });
    await bob.handleContactFrame("chat-ab", { t: "group-chain", g: groupId, commits: "not a list" });
    await bob.handleContactFrame("chat-ab", { t: "group-welcome", g: groupId, commits: [], secrets: [] });
    expect(view(bob).invitation).toMatchObject({ accepted: true });
    await bob.handleContactFrame("chat-xb", { t: "group-welcome", g: groupId, commits: [], secrets: [] });
    await world.settle();
    expect(view(bob)).toMatchObject({ status: "active", epoch: 1 });
  });

  it("a removal notice from someone other than the admin's chat is ignored", async () => {
    const { world, others: [bob, carol], groupId } = await groupOf(["bob", "carol"]);
    world.chats.set("chat-bc", ["bob", "carol"]);
    await carol.handleContactFrame("chat-bc", { t: "group-removed", g: groupId });
    await carol.handleContactFrame("chat-ab", { t: "group-removed", g: "C".repeat(22) });
    expect(view(carol, groupId).status).toBe("active");
    void bob;
  });

  it("an edge coming up for someone not in the roster is not told anything; a nick from the edge names the member", async () => {
    const { world, alice, others: [bob], groupId, key } = await groupOf(["bob"]);
    const sent = vi.spyOn((alice as unknown as { host: GroupsHost }).host, "sendOnLink");
    alice.edgeReady(groupId, createIdentity().pubKeyZ32, "edge:alice:nobody");
    alice.edgeReady("unknown-group", key(bob), "edge:alice:nobody");
    expect(sent).not.toHaveBeenCalled();
    alice.edgeNick(groupId, key(bob), "Bobby");
    await world.settle();
    expect(view(alice, groupId).members.find(m => m.key === key(bob))!.nick).toBe("Bobby");
  });
});

describe("the group's link: knocks, pending entries and refusals", () => {
  const timings: EntryTimings = { pollMs: 1_000, knockMs: 2_000, slowKnockMs: 10_000, patienceMs: 30_000 };

  it("a joiner knocks at its pace, slower once it has waited long, and not while its entry session is up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const world = new World();
    const alice = world.add("alice"), dan = world.add("dan", timings);
    const groupId = await alice.create("Ghosts");
    await dan.joinByLink(await alice.enableLink(groupId)); await flush();
    expect(world.publishes).toBe(1);
    await dan.tick(t0 + 1_000);
    expect(world.publishes).toBe(1);
    await dan.tick(t0 + 2_000);
    expect(world.publishes).toBe(2);
    await dan.tick(t0 + 40_000);
    expect(world.publishes).toBe(3);
    await dan.tick(t0 + 45_000);
    expect(world.publishes).toBe(3); // patience ran out: every ten seconds now
    await dan.tick(t0 + 50_000);
    expect(world.publishes).toBe(4);
    // The admin's app answers: a session is up, and knocking stops.
    await alice.tick(t0 + 50_000); await world.settle();
    await dan.tick(t0 + 70_000);
    expect(world.publishes).toBe(4);
  });

  it("an admission that does not finish in time is dropped and that key is not answered again for a while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const world = new World();
    const alice = world.add("alice", timings), dan = world.add("dan", timings);
    const groupId = await alice.create("Ghosts");
    await dan.joinByLink(await alice.enableLink(groupId)); await flush();
    const hostEntries = () => [...world.peers.get("alice")!.entries.values()].length;
    await alice.tick(t0); await world.settle();
    expect(hostEntries()).toBe(1);
    // Dan never finishes (the entry is not ready on both sides); three minutes on, the admin gives up.
    await alice.tick(t0 + 3 * 60_000 + 1);
    expect(hostEntries()).toBe(0);
    vi.setSystemTime(t0 + 4 * 60_000);
    await dan.tick(t0 + 4 * 60_000);
    await alice.tick(t0 + 4 * 60_000 + 2_000);
    expect(hostEntries()).toBe(0); // knocked again, but refused for now
    vi.setSystemTime(t0 + 14 * 60_000);
    await dan.tick(t0 + 14 * 60_000);
    await alice.tick(t0 + 14 * 60_000 + 2_000);
    // The refusal ran out during that look; the next one answers.
    await alice.tick(t0 + 14 * 60_000 + 4_000);
    expect(hostEntries()).toBe(1);
  });

  it("at most four admissions run at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = new World();
    const alice = world.add("alice", timings);
    const groupId = await alice.create("Ghosts");
    const code = await alice.enableLink(groupId);
    for (let i = 0; i < 5; i++) { await world.add(`j${i}`).joinByLink(code); await flush(); }
    await alice.tick(Date.now()); await world.settle();
    expect(world.peers.get("alice")!.entries.size).toBe(4);
  });

  it("an entry session that cannot be opened is tried again at the next look", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const world = new World();
    const alice = world.add("alice", timings), dan = world.add("dan");
    const groupId = await alice.create("Ghosts");
    await dan.joinByLink(await alice.enableLink(groupId)); await flush();
    world.peers.get("alice")!.failEntry = true;
    await alice.tick(t0);
    expect(world.peers.get("alice")!.entries.size).toBe(0);
    world.peers.get("alice")!.failEntry = false;
    await alice.tick(t0 + 500);
    expect(world.peers.get("alice")!.entries.size).toBe(0); // not due yet
    await alice.tick(t0 + 1_000);
    expect(world.peers.get("alice")!.entries.size).toBe(1);
  });

  it("a joiner declining on the entry session closes it; an entry the admin did not open is not invited", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = new World();
    const alice = world.add("alice", timings), dan = world.add("dan");
    const groupId = await alice.create("Ghosts");
    await dan.joinByLink(await alice.enableLink(groupId)); await flush();
    const sent = vi.spyOn((alice as unknown as { host: GroupsHost }).host, "sendOnLink");
    alice.entryReady(groupId, "entry:alice:stranger", createIdentity().pubKeyZ32);
    expect(sent).not.toHaveBeenCalled();
    await alice.tick(Date.now()); await world.settle();
    const [linkId] = [...world.peers.get("alice")!.entries.keys()];
    await alice.handleContactFrame(linkId, { t: "group-decline", g: groupId });
    expect(world.peers.get("alice")!.entries.size).toBe(0);
  });

  it("joining by link: the same link again is a no-op, a pending contact invitation is not overridden, an old membership is replaced", async () => {
    const world = new World();
    const alice = world.add("alice"), bob = world.add("bob");
    world.chats.set("chat-ab", ["alice", "bob"]);
    const groupId = await alice.create("Ghosts");
    const code = await alice.enableLink(groupId);
    await alice.invite(groupId, "chat-ab"); await world.settle();
    await bob.accept(groupId);
    await expect(bob.joinByLink(code)).rejects.toThrow(/already joining/);
    await world.settle();
    expect(await bob.joinByLink(code)).toBe(groupId); // already in: nothing happens
    expect(world.peers.get("bob")!.entries.size).toBe(0);
    await bob.leave(groupId); await world.settle();
    expect(await bob.joinByLink(code)).toBe(groupId);
    expect(view(bob).invitation).toMatchObject({ viaLink: true, accepted: true });
    expect(await bob.joinByLink(code)).toBe(groupId);
    expect(world.peers.get("bob")!.entries.size).toBe(1);
  });

  it("the link goes off by itself once its maker is no longer the admin; turning off a link that is not on is harmless", async () => {
    const { world, alice, others: [bob], groupId, key } = await groupOf(["bob"]);
    await alice.disableLink(groupId);
    await alice.enableLink(groupId);
    await alice.makeAdmin(groupId, key(bob)); await world.settle();
    await alice.tick();
    expect(world.peers.get("alice")!.store.groups.get(groupId)!.entry).toBeUndefined();
    await expect(alice.enableLink(groupId)).rejects.toThrow(/Only the admin/);
  });
});
