import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.join

/**
 * Someone opens a community's link, a member lets them in, and the welcome is lost (the joiner's app closed under it).
 * Before it knocks again the admin replaces the link: no member reads the old link's knocks any more, so the welcome
 * never comes. The joiner sat on "getting the group's keys. You are in in a moment." for an hour. Its view says since
 * when it was let in, so the card can tell it after a few minutes to ask for the current link.
 */
describe("a community joiner whose welcome was lost, the link replaced before it knocks again", { timeout: 120_000 }, () => {
  it("stays let in with the time it was let in, not moved on by its knocks", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Door");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 60_000);
    const carol = world.add("carol");
    world.drop = (_from, to, f) => to === carol && (f.t === "group-welcome" || f.t === "group-chain");
    await carol.groups.joinByLink(link);
    await world.until(() => world.view(carol, id)?.invitation?.stage === "admitted", 5 * 60_000);
    const letIn = world.now;
    // Its side drops under the welcome; the admin replaces the link.
    for (const [linkId] of [...carol.links].filter(([, e]) => e.kind === "guest" && e.g === id)) carol.links.delete(linkId);
    await world.until(() => alice.groups.communities.isHub(id), 3 * 60_000);
    await alice.groups.enableLink(id, true);
    await world.run(6 * 60_000);
    const invitation = world.view(carol, id)?.invitation;
    expect(invitation?.stage).toBe("admitted");
    expect(invitation?.admittedAt).toBeGreaterThan(letIn - 60_000);
    expect(invitation?.admittedAt).toBeLessThanOrEqual(letIn);
    expect(world.now - invitation!.admittedAt!).toBeGreaterThan(5 * 60_000);
  });

  it("a joiner not let in yet has no such time", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), carol = world.add("carol");
    const id = await alice.groups.create("Door");
    const link = await alice.groups.enableLink(id);
    alice.online = false;
    await carol.groups.joinByLink(link);
    await world.run(60_000);
    expect(world.view(carol, id)?.invitation?.stage).not.toBe("admitted");
    expect(world.view(carol, id)?.invitation?.admittedAt).toBeUndefined();
  });
});
