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
  });
});
