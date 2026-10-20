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

  it("that knocks again as fast as it likes gets its welcome again at most every half minute", async () => {
    const world = new CommunityWorld(undefined, null);
    const alice = world.add("alice"), carol = world.add("carol"), mallory = world.add("mallory");
    const id = await alice.groups.create("Ghosts", "mesh");
    const link = await alice.groups.enableLink(id);
    await carol.groups.joinByLink(link);
    await world.until(() => world.view(alice, id)?.members.length === 2 && world.view(carol, id)?.status === "active", 10 * 60_000);
    // Every welcome to Mallory is lost, and her app, after each, drops its entry session and opens a fresh one at once.
    let welcomes = 0, dropped = false;
    world.drop = (from, to, f) => {
      if (from !== alice || to !== mallory || (f.t !== "group-welcome" && f.t !== "group-chain")) return false;
      if (f.t === "group-welcome") { welcomes++; dropped = true; }
      return true;
    };
    await mallory.groups.joinByLink(link);
    await world.until(() => welcomes > 0, 5 * 60_000);
    const minutes = 10, start = world.now;
    welcomes = 0;
    while (world.now - start < minutes * 60_000) {
      if (dropped) {
        dropped = false;
        for (const [linkId, e] of [...mallory.links].filter(([, e]) => e.kind === "guest" && e.g === id)) {
          mallory.links.delete(linkId);
          await world.run(1000);
          mallory.links.set(linkId, { ...e, announced: false, openedAt: world.now, fastUntil: world.now, lastPoll: -Infinity, polls: 0 });
        }
      }
      await world.run(1000);
    }
    expect(welcomes).toBeLessThanOrEqual(minutes * 2 + 1);
    expect(world.view(alice, id)!.members).toHaveLength(3);
  });
});
