import { afterEach, describe, expect, it, vi } from "vitest";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { GROUP_PROFILE, commitUntaggedHash, confirmationTag, epochKeys, identityFromSeedB64, newEpochSecret, randomBytes, signCommit, toBase64Url, type GhostRecord, type GroupCommit, type GroupState } from "@ghostly/core";
import type { StoredGroup, StoredMessage } from "../src/shared/types";
// covers: groups.invite, groups.link.join

/**
 * A private group's id is chosen at random and names no genesis: anyone who knows it can hold a group of their own under
 * it. Another group that comes under an id this device holds (an invitation from someone outside the group held, a
 * link) is kept beside it and shown, and the person picks which one is real; whoever they turn down hears a decline.
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
interface Peer { groups: Groups; host: GroupsHost; messages: StoredMessage[]; edges: Map<string, Edge>; entries: Map<string, Entry>; store: ReturnType<typeof memoryStore> }

/** Peers joined by contact chats and by the edges and entry sessions their engines ask for; frames wait for `settle()`. */
class World {
  readonly peers = new Map<string, Peer>();
  readonly pkarr = new Map<string, GhostRecord[]>();
  readonly chats = new Map<string, [string, string]>();
  readonly sent: { from: string; linkId: string; t: unknown }[] = [];
  private queue: (() => Promise<unknown>)[] = [];

  private counterpart(entry: Entry): { name: string; linkId: string } | undefined {
    for (const [name, peer] of this.peers) for (const [linkId, e] of peer.entries) if (e.g === entry.g && e.me === entry.peer && e.peer === entry.me) return { name, linkId };
    return undefined;
  }
  async meetEntries(): Promise<void> {
    for (const peer of this.peers.values()) for (const [linkId, e] of peer.entries) if (e.role === "host" && this.counterpart(e)) peer.groups.entryReady(e.g, linkId, e.peer);
    await this.settle();
  }
  add(name: string): Peer {
    const peer = { messages: [], edges: new Map(), entries: new Map() } as unknown as Peer;
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const copy = structuredClone(frame) as Record<string, unknown>;
        const chat = this.chats.get(linkId);
        if (chat) { this.sent.push({ from: name, linkId, t: copy.t }); const other = this.peers.get(chat[0] === name ? chat[1] : chat[0])!; this.queue.push(() => other.groups.handleContactFrame(linkId, copy)); return; }
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
        const id = `entry:${name}:${key.slice(0, 8)}`;
        peer.entries.set(id, { g: link.g, me: identityFromSeedB64(seedB64).pubKeyZ32, peer: key, role });
        return id;
      },
      entries: groupId => new Map([...peer.entries.entries()].filter(([, e]) => e.g === groupId).map(([id, e]) => [e.peer, id])),
      publish: async (identity, records) => { this.pkarr.set(identity.pubKeyZ32, records); },
      resolve: async key => this.pkarr.get(key) ?? null,
      edgeNick: () => undefined,
      storeMessage: async message => { if (!peer.messages.some(m => m.id === message.id)) peer.messages.push(message); },
      emit: () => {},
    };
    peer.host = host;
    peer.store = memoryStore(peer.messages);
    peer.groups = new Groups(host, peer.store);
    this.peers.set(name, peer);
    return peer;
  }
  async meet(): Promise<void> {
    for (const peer of this.peers.values()) for (const [linkId, edge] of peer.edges) peer.groups.edgeReady(edge.state.id, edge.peer, linkId);
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const batch = this.queue.splice(0);
      await new Promise<void>(r => setImmediate(r));
      if (!batch.length && !this.queue.length) break;
      for (const run of batch) await run();
    }
  }
  texts(name: string): string[] { return this.peers.get(name)!.messages.filter(m => !m.event).map(m => m.text); }
}
const view = (g: Groups, id: string) => g.views().find(v => v.id === id);
const adminOf = (g: Groups, id: string) => view(g, id)?.members.find(m => m.role === "admin")?.key;

/** A group of someone's own under an id they chose: a genesis signed under it, as GroupSession.create signs one under a random id. */
function genesisUnder(id: string, name: string, now = Date.now()): GroupState {
  const identity = identityFromSeedB64(toBase64Url(randomBytes(32)));
  const secret = newEpochSecret();
  const draft: Omit<GroupCommit, "sig" | "c"> = { v: 1, g: id, e: 0, p: "", k: "create", m: [[identity.pubKeyZ32, "admin"]], by: identity.pubKeyZ32, ts: now };
  const commit = signCommit({ ...draft, c: confirmationTag(epochKeys(secret, id, 0).confirm, commitUntaggedHash(draft)) }, identity.seed);
  return { id, name, profile: GROUP_PROFILE, seedB64: identity.seedB64, createdAt: now, chain: [commit],
    secrets: { 0: toBase64Url(secret) }, status: "active", seq: 0, seqEpoch: 0, sent: [], seen: {}, nicks: {} } as GroupState;
}

/** Alice makes "Family"; Mallory, a member, holds a group of her own under its id on a second profile. Bob is both's contact. */
async function setup() {
  const world = new World();
  const alice = world.add("alice").groups, bob = world.add("bob").groups, mallory = world.add("mallory").groups;
  const other = world.add("other");
  world.chats.set("chat-ab", ["alice", "bob"]); world.chats.set("chat-am", ["alice", "mallory"]); world.chats.set("chat-bo", ["bob", "other"]);
  for (const g of [alice, bob, mallory]) await g.load();
  const g = await alice.create("Family", "mesh");
  await alice.invite(g, "chat-am"); await world.settle(); await mallory.accept(g); await world.settle(); await world.meet();
  const copy = genesisUnder(g, "Family");
  other.store.groups.set(g, { id: g, createdAt: copy.createdAt, state: copy, contacts: {} });
  await other.groups.load();
  return { world, alice, bob, other: other.groups, g };
}

async function joinLoop(world: World, joiner: Groups, admins: Groups[], g: string, done: () => boolean) {
  for (let i = 0; i < 10 && !done(); i++) {
    vi.setSystemTime(Date.now() + 2_000);
    for (const a of admins) await a.tick(Date.now());
    await joiner.tick(Date.now()); await world.settle(); await world.meetEntries(); await world.meet();
  }
}

afterEach(() => { vi.useRealTimers(); });

describe("another group under an id this device holds", () => {
  it("an invitation waiting: the second one is shown beside it, and the person picks the real one", async () => {
    const { world, alice, bob, other, g } = await setup();
    await other.invite(g, "chat-bo"); await world.settle();
    await alice.invite(g, "chat-ab"); await world.settle();
    expect(view(bob, g)?.invitation?.linkId).toBe("chat-bo");
    expect(view(bob, g)?.others).toEqual([expect.objectContaining({ linkId: "chat-ab", contact: "contact:chat-ab", name: "Family" })]);
    world.sent.length = 0;
    await bob.switchGroup(g, "chat-ab"); await world.settle();
    // The one turned down hears it; the one picked waits for Bob's answer.
    expect(world.sent).toContainEqual({ from: "bob", linkId: "chat-bo", t: "group-decline" });
    expect(view(other, g)?.invited).toEqual([]);
    expect(view(bob, g)?.invitation?.linkId).toBe("chat-ab");
    expect(view(bob, g)?.others).toBeUndefined();
    await bob.accept(g); await world.settle(); await world.meet();
    expect(view(bob, g)?.status).toBe("active");
    expect(adminOf(bob, g)).toBe(view(alice, g)?.myKey);
  });

  it("in the other group already: the real admin's invitation is shown, Keep answers it with a decline, Switch takes Bob to it", async () => {
    const { world, alice, bob, other, g } = await setup();
    await other.invite(g, "chat-bo"); await world.settle(); await bob.accept(g); await world.settle(); await world.meet();
    expect(adminOf(bob, g)).toBe(view(other, g)?.myKey);
    await alice.invite(g, "chat-ab"); await world.settle();
    expect(view(bob, g)?.others).toEqual([expect.objectContaining({ linkId: "chat-ab" })]);
    // Kept: Alice is told no, and no longer shows Bob as invited.
    world.sent.length = 0;
    await bob.keepGroup(g); await world.settle();
    expect(world.sent).toContainEqual({ from: "bob", linkId: "chat-ab", t: "group-decline" });
    expect(view(alice, g)?.invited).toEqual([]);
    expect(view(bob, g)?.others).toBeUndefined();
    // Asked again, Bob switches: out of the other group, into Alice's, and her messages reach him.
    await alice.invite(g, "chat-ab"); await world.settle();
    await bob.switchGroup(g, "chat-ab"); await world.settle();
    expect(view(bob, g)?.invitation?.linkId).toBe("chat-ab");
    await bob.accept(g); await world.settle(); await world.meet();
    expect(adminOf(bob, g)).toBe(view(alice, g)?.myKey);
    expect((await alice.send(g, "dinner at 8")).error).toBeNull();
    await world.settle();
    expect(world.texts("bob")).toContain("dinner at 8");
  });

  it("in the other group through its link: the real link is shown beside it and opens the real group once picked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { world, alice, bob, other, g } = await setup();
    const real = await alice.enableLink(g), copy = await other.enableLink(g);
    await bob.joinByLink(copy); await world.settle();
    await joinLoop(world, bob, [alice, other], g, () => view(bob, g)?.status === "active");
    expect(adminOf(bob, g)).toBe(view(other, g)?.myKey);
    expect(await bob.joinByLink(real)).toBe(g);
    expect(view(bob, g)?.others).toEqual([expect.objectContaining({ link: real })]);
    await bob.switchGroup(g, real); await world.settle();
    await joinLoop(world, bob, [alice, other], g, () => view(bob, g)?.status === "active");
    expect(adminOf(bob, g)).toBe(view(alice, g)?.myKey);
    expect(view(bob, g)?.others).toBeUndefined();
  });

  it("an invitation waiting, then a link under its id: shown beside it, not refused", async () => {
    const { world, alice, bob, other, g } = await setup();
    await other.invite(g, "chat-bo"); await world.settle();
    const real = await alice.enableLink(g);
    expect(await bob.joinByLink(real)).toBe(g);
    expect(view(bob, g)?.invitation?.linkId).toBe("chat-bo");
    expect(view(bob, g)?.others).toEqual([expect.objectContaining({ link: real })]);
  });

  it("the same group is no other: its admin inviting a member again, or its own link opened by its admin", async () => {
    const { world, alice, bob, g } = await setup();
    await alice.invite(g, "chat-ab"); await world.settle(); await bob.accept(g); await world.settle(); await world.meet();
    // An invitation said again by its admin (its app lost the answer), and one from a member's key: both are this group.
    await bob.handleContactFrame("chat-ab", { t: "group-invite", g, admin: view(alice, g)!.myKey, name: "Family" });
    await bob.handleContactFrame("chat-ab", { t: "group-invite", g, admin: view(bob, g)!.members.find(m => !m.me && m.role !== "admin")!.key, name: "Family" });
    expect(view(bob, g)?.others).toBeUndefined();
    const real = await alice.enableLink(g);
    expect(await alice.joinByLink(real)).toBe(g);
    expect(view(alice, g)?.others).toBeUndefined();
  });

  it("deleting the held group answers the others too: nobody is left counting this device as invited", async () => {
    const { world, alice, bob, other, g } = await setup();
    await other.invite(g, "chat-bo"); await world.settle();
    await alice.invite(g, "chat-ab"); await world.settle();
    await bob.decline(g); await world.settle();
    expect(view(alice, g)?.invited).toEqual([]);
    expect(view(other, g)?.invited).toEqual([]);
  });
});
