import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.remove, groups.protocol.community-topology

/**
 * A member's one hub is removed, and that hub's app never takes in the commit that removes it (a modified app, or one
 * that kept a copy of its state): it keeps the member's edge up and goes on listing itself in the beacon. The member
 * heard the chain only from that hub, so it stayed on the epoch before the removal, and whatever it wrote went to the
 * removed hub alone (bug hunt, 2026-11-02). It now looks past its one hub: on the beacon's head naming a newer epoch
 * than its own, or on readings of the beacon that keep leaving its hub out, it asks another hub too, and catches up.
 */
describe("a member whose one hub was removed, and whose hub does not take that in", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  type Live = { myHubs: string[] };
  const liveOf = (p: Peer, id: string) => (p.groups.communities as unknown as { live: Map<string, Live> }).live.get(id)!;
  const keyOf = (world: CommunityWorld, p: Peer, id: string) => world.view(p, id)!.myKey!;
  /**
   * The admin removes Bob alone, as an app from before revision 2026-11-03 does: one that removes him now also takes out
   * Carol and Dave, whom he let in, and Dave is the member this is about.
   */
  type Commits = { serialize<T>(run: () => Promise<T>): Promise<T>; commit(kind: "remove", fields: { s: string }, now: number): Promise<unknown> };
  const removeAlone = (p: Peer, id: string, key: string) => {
    const s = p.groups.communities.session(id) as unknown as Commits;
    return s.serialize(() => s.commit("remove", { s: key }, Date.now()));
  };

  /** Alice (admin) lets Bob in; with her app closed, Bob lets Carol and Dave in: Dave's one hub is Bob. */
  async function setUp(seed: number) {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol"), dave = world.add("dave");
    const id = await alice.groups.create("Town");
    const link = `https://app.ghostly.tools/#/join/${await alice.groups.enableLink(id)}`;
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 5 * 60_000);
    await world.run(30_000);
    alice.online = false;
    for (const p of [carol, dave]) {
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 5 * 60_000);
    }
    await world.run(60_000);
    alice.online = true;
    await world.run(90_000);
    const bobKey = keyOf(world, bob, id);
    // Whoever has Bob for its one hub (Dave, and maybe more): the members this is about.
    const carried = [alice, carol, dave].filter(p => !p.groups.communities.isHub(id) && liveOf(p, id).myHubs.length === 1 && liveOf(p, id).myHubs[0] === bobKey);
    expect(carried.map(p => p.name)).toContain("dave");
    expect(bob.groups.communities.isHub(id)).toBe(true);
    expect([alice, carol].some(p => p.groups.communities.isHub(id))).toBe(true);
    // Bob's app drops every commit after the one it holds now: it never hears it was removed.
    const bobEpoch = bob.groups.communities.session(id)!.epoch;
    const later = (c: unknown) => !!c && typeof c === "object" && (c as { e?: number }).e! > bobEpoch;
    world.drop = (_from, to, frame) => to === bob && (later(frame.commit) || (Array.isArray(frame.commits) && frame.commits.some(later)));
    return { world, alice, bob, carol, dave, id, bobKey };
  }

  it("the group goes on talking: the member catches up past its hub, and the removed hub reads nothing after", async () => {
    const { world, alice, bob, dave, id, bobKey } = await setUp(7);
    await removeAlone(alice, id, bobKey);
    await world.run(60_000);
    expect(world.view(bob, id)?.status).toBe("active");
    await alice.groups.send(id, "alice after the removal");
    await world.until(() => dave.groups.communities.session(id)!.wasRemoved(bobKey), 5 * 60_000);
    await world.run(5_000);
    expect(liveOf(dave, id).myHubs).not.toContain(bobKey);
    await dave.groups.send(id, "dave after the removal");
    await world.until(() => world.texts(alice, id).includes("dave after the removal"), 60_000);
    expect(world.texts(bob, id)).not.toContain("dave after the removal");
    expect(world.texts(dave, id)).toContain("alice after the removal");
  });

  it("nobody else talks: the beacon keeps leaving the hub out, and the member catches up all the same", async () => {
    const { world, alice, bob, dave, id, bobKey } = await setUp(11);
    await removeAlone(alice, id, bobKey);
    await world.until(() => dave.groups.communities.session(id)!.wasRemoved(bobKey), 5 * 60_000);
    expect(world.view(bob, id)?.status).toBe("active");
    await world.run(5_000);
    expect(liveOf(dave, id).myHubs).not.toContain(bobKey);
    await dave.groups.send(id, "dave after the removal");
    await world.until(() => world.texts(alice, id).includes("dave after the removal"), 60_000);
    expect(world.texts(bob, id)).not.toContain("dave after the removal");
  });
});
