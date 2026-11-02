import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * The admin replaces the link while a member's door is letting someone in through the old one. The welcome that
 * member said named the new entry key, which the joiner, holding the old link, refuses: it waited on "admitted" for
 * good, and its key stayed in every roster as a member nobody held.
 */
describe("a link replaced while a member's door lets someone in through it", { timeout: 120_000 }, () => {
  it("the member closes that entry session and admits nobody on it: no key in the roster that nobody holds", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Door");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 60_000);
    await world.until(() => bob.groups.communities.isHub(id), 3 * 60_000);
    // Alice's app closes: Bob is the only hub, and the door.
    alice.online = false;
    await world.run(3 * 60_000);
    // Carol opens the link; Bob opens her entry session, slow to come up.
    const carol = world.add("carol");
    let apart = true;
    world.cut = (a, b) => apart && [a, b].includes(bob) && [a, b].includes(carol);
    await carol.groups.joinByLink(link);
    const hostFor = (p: Peer) => [...p.links.values()].filter(e => e.kind === "host" && e.g === id);
    await world.until(() => hostFor(bob).length > 0, 60_000);
    // Alice comes back and replaces the link; Bob follows the new entry key.
    alice.online = true;
    await world.until(() => alice.groups.communities.isHub(id), 60_000);
    const fresh = await alice.groups.enableLink(id, true);
    await world.until(() => bob.groups.communities.entryLink(id) === fresh, 60_000);
    // The session Bob opened through the old link goes with it.
    await world.run(2_000);
    expect(hostFor(bob)).toEqual([]);
    apart = false;
    await world.run(10 * 60_000);
    for (const p of [alice, bob]) expect(world.view(p, id)!.members, p.name).toHaveLength(2);
    expect(world.view(carol, id)?.invitation?.stage).not.toBe("admitted");
  });
});
