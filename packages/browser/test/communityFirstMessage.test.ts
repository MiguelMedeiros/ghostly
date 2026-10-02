import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK } from "./communityWorld";
// covers: groups.community.catch-up, groups.community.send, groups.community.join

/**
 * Someone opens a community's link and writes as soon as it is in: no edge is up yet, so nobody hears it, and it does
 * not hear that someone else is let in right after. The first member it then reaches is that newcomer (its hub), who
 * was not in the group when the message was sealed. Seen with six CLI daemons on local relays on 2026-10-02: the
 * message reached nobody, for good, though `group send --wait sent` said it would go when an edge opened. On headless
 * engines (`CommunityWorld`, simulated clock and relay budget).
 */
describe("a joiner's first message in a community, written before any edge is up", { timeout: 120_000 }, () => {
  it("reaches the members it was written for through a hub let in after it, which cannot read it", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const admin = world.add("admin");
    const id = await admin.groups.create("First");
    const link = await admin.groups.enableLink(id);
    await world.run(60_000);
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 5 * 60_000, 500);
    // In, with the admin alone, and no edge yet: it writes, and hears nothing for a while.
    let apart = true;
    world.cut = (a, b) => apart && (a === bob || b === bob);
    expect(world.view(bob, id)!.members).toHaveLength(2);
    const sent = await bob.groups.send(id, "first words");
    expect(sent.error).toBeNull();
    expect(bob.groups.taken(id, sent.messageId!)).toBe(0);
    // Carol is let in meanwhile, and stays: once the admin's app closes she is the hub Bob reaches.
    const carol = world.add("carol", undefined, { staysOnline: true });
    await carol.groups.joinByLink(link);
    await world.until(() => world.member(carol, id), 5 * 60_000, 500);
    admin.online = false;
    apart = false;
    await world.until(() => bob.groups.taken(id, sent.messageId!) > 0, 10 * 60_000);
    await world.run(5_000);
    // Carol was not in the group when it was written: she shows nothing.
    expect(world.texts(carol, id)).toEqual([]);
    // Bob's app closes before the admin's opens again: only Carol holds what he wrote.
    bob.online = false;
    world.reopen(admin);
    const took = await world.until(() => world.texts(admin, id).includes("first words"), 5 * 60_000);
    expect(took).toBeLessThanOrEqual(2 * 60_000);
    await world.run(2 * 60_000);
    expect(world.texts(admin, id)).toEqual(["first words"]);
    expect(world.texts(carol, id)).toEqual([]);
  });
});
