import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_GOSSIP_MS } from "../src/engine/groups";
// covers: groups.catch-up, groups.community.catch-up

/**
 * A group is unread when another member's message came after I last looked at it (`lastPeerMessageAt` against the
 * time the app marked it read). A message written before I looked but handed to me only later (its author and I were
 * cut apart, and another member caught me up) came after: it is unread, though its own time is older.
 */
async function groupOf(kind: "mesh" | "community", names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld();
  // Every clock on the world's: a message's own time is when its author sent it, in simulated time too.
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = kind === "mesh" ? await admin.groups.create("Late", "mesh") : await admin.groups.create("Late");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
  const peers = [admin, ...rest];
  await world.run(60_000);
  return { world, peers, id };
}

describe("a group's unread mark and a message that reaches me late", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("in a private group: one caught up from a third member after I looked at the group is unread", async () => {
    const { world, peers, id } = await groupOf("mesh", ["alice", "bob", "carol"]);
    const [alice, bob] = peers;
    world.cut = (a, b) => (a === alice && b === bob) || (a === bob && b === alice);
    await world.run(3_000);
    await alice.groups.send(id, "written before Bob looked");
    await world.run(5_000);
    expect(world.texts(bob, id)).not.toContain("written before Bob looked");
    // Bob opens the group now (the app marks it read at this time), answers someone else, and goes elsewhere.
    const readAt = world.now;
    await bob.groups.send(id, "my reply");
    await world.until(() => world.texts(bob, id).includes("written before Bob looked"), MESH_GOSSIP_MS + 10_000);
    expect(world.view(bob, id)!.lastPeerMessageAt).toBeGreaterThan(readAt);
    // Bob's app starts again before he opens the group: it is still unread (its history alone says the message is old).
    await world.restart(bob);
    expect(world.view(bob, id)!.lastPeerMessageAt).toBeGreaterThan(readAt);
  });

  it("in a community: one caught up when my hub's edge comes back after I looked at the group is unread", async () => {
    const { world, peers, id } = await groupOf("community", ["alice", "bob", "carol"]);
    const bob = peers.find(p => !p.groups.communities.isHub(id))!;
    const author = peers.find(p => p !== bob)!;
    const others = peers.filter(p => p !== bob);
    // Bob is cut from everyone a moment; the author speaks meanwhile.
    world.cut = (a, b) => (a === bob && others.includes(b)) || (b === bob && others.includes(a));
    await world.run(3_000);
    await author.groups.send(id, "written before Bob looked");
    await world.run(5_000);
    expect(world.texts(bob, id)).not.toContain("written before Bob looked");
    const readAt = world.now;
    world.cut = null;
    await world.until(() => world.texts(bob, id).includes("written before Bob looked"), 3 * 60_000);
    expect(world.view(bob, id)!.lastPeerMessageAt).toBeGreaterThan(readAt);
    // The same after Bob's app starts again (a community saves what a message moved a second later, in a batch).
    await new Promise(r => setTimeout(r, 1_100));
    await world.restart(bob);
    expect(world.view(bob, id)!.lastPeerMessageAt).toBeGreaterThan(readAt);
  });

  it.each(["mesh", "community"] as const)("in a %s group: a message that comes within a second of my leaving it is unread", async (kind) => {
    const { world, peers, id } = await groupOf(kind, ["alice", "bob"]);
    const [alice, bob] = peers;
    await world.until(() => [alice, bob].every(p => world.view(p, id)!.members.some(m => !m.me && m.online)), 5 * 60_000);
    // The engine ticks once a second; the device's clock goes on between two ticks.
    let wall = world.now;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    // Bob looks at the group 0.8 s after the last tick (the page marks it read by the device's clock) and leaves.
    wall += 800;
    const readAt = wall;
    // Alice's message comes 0.1 s later, before the next tick.
    wall += 100;
    await alice.groups.send(id, "just after Bob left");
    await world.settle();
    expect(world.texts(bob, id)).toContain("just after Bob left");
    expect(world.view(bob, id)!.lastPeerMessageAt).toBeGreaterThan(readAt);
  });

  it("a mention that reached me late is still marked after a restart", async () => {
    const { world, peers, id } = await groupOf("mesh", ["alice", "bob", "carol"]);
    const [alice, bob] = peers;
    const bobKey = world.view(bob, id)!.myKey!;
    world.cut = (a, b) => (a === alice && b === bob) || (a === bob && b === alice);
    await world.run(3_000);
    await alice.groups.send(id, "@bob look", [{ k: bobKey, o: 0, l: 4 }]);
    await world.run(5_000);
    const readAt = world.now;
    await world.until(() => world.texts(bob, id).includes("@bob look"), MESH_GOSSIP_MS + 10_000);
    expect(world.view(bob, id)!.lastMentionAt).toBeGreaterThan(readAt);
    await world.restart(bob);
    expect(world.view(bob, id)!.lastMentionAt).toBeGreaterThan(readAt);
  });
});
