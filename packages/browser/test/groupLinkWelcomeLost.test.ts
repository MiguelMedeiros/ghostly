import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.link.join, groups.protocol.entry

/**
 * Someone opens a private group's link and the admin's app lets them in, but the welcome is lost on the entry session
 * (the joiner's phone locked under it, the session closed). The admission is in the admin's roster: the joiner knocks
 * again, and the admin's app opens the session again for the welcome, with no second place taken.
 */

describe("a link joiner whose welcome was lost", { timeout: 120_000 }, () => {
  it("knocks again and gets the welcome over a new entry session, in the roster once", async () => {
    const world = new CommunityWorld(undefined, null);
    const alice = world.add("alice"), carol = world.add("carol"), bob = world.add("bob");
    const id = await alice.groups.create("Ghosts", "mesh");
    const link = await alice.groups.enableLink(id);
    await carol.groups.joinByLink(link);
    await world.until(() => world.view(alice, id)?.members.length === 2 && world.view(carol, id)?.status === "active", 10 * 60_000);
    let lost = 0;
    world.drop = (from, to, f) => from === alice && to === bob && (f.t === "group-welcome" || f.t === "group-chain") && lost++ < 1;
    await bob.groups.joinByLink(link);
    await world.until(() => world.view(alice, id)!.members.length === 3, 5 * 60_000);
    expect(lost).toBe(1);
    expect(world.view(bob, id)?.invitation?.stage).toBe("admitted");
    // The joiner's side dropped under the welcome: the admin's app closes the entry session (`entryDone`).
    for (const [linkId, e] of alice.links) if (e.kind === "host" && e.g === id) alice.links.delete(linkId);

    await world.until(() => world.view(bob, id)?.status === "active", 10 * 60_000, 1000, () => `bob at stage ${world.view(bob, id)?.invitation?.stage}`);
    await world.until(() => world.view(alice, id)!.members.every(m => m.online), 5 * 60_000);
    expect(world.view(alice, id)!.members).toHaveLength(3);
    expect(world.view(bob, id)!.members).toHaveLength(3);
    expect(world.view(carol, id)!.members).toHaveLength(3);
  });
});
