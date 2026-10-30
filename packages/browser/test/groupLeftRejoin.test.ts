import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.protocol.entry

/**
 * agents#1652: a member leaves a private group while the admin's app is closed, then opens the group's link again before
 * the admin heard the leave. Opening the link forgot the tombstone that was to say the leave, so the admin let the new
 * key in and kept the old one: the person stayed in every roster twice for good, and every member kept an edge looking
 * for a key that never comes back.
 */
describe("a member who left while the admin was away, back by the link", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is in the group once: the admin takes the old key out when it lets the new one in", async () => {
    const world = new CommunityWorld();
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const id = await alice.groups.create("Door", "mesh");
    const link = await alice.groups.enableLink(id);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
    await world.until(() => [alice, bob, carol].every(p => world.view(p, id)!.members.length === 3), 60_000);
    const oldBob = world.view(bob, id)!.myKey!;

    alice.online = false;
    await world.run(5_000);
    await bob.groups.leave(id);
    await world.run(5_000);
    await bob.groups.joinByLink(link);
    await world.run(5_000);
    world.reopen(alice);
    await world.until(() => world.member(bob, id), 5 * 60_000);
    const newBob = world.view(bob, id)!.myKey!;
    await world.run(2 * 60_000);

    const roster = (p: typeof alice) => world.view(p, id)!.members.map(m => m.key);
    expect(roster(alice)).toContain(newBob);
    expect(roster(alice), "the admin took the old key out").not.toContain(oldBob);
    expect(roster(carol), "every member took the old key out").not.toContain(oldBob);
    expect([...alice.host.edges(id).keys()], "no edge kept for the old key").not.toContain(oldBob);
    expect([...carol.host.edges(id).keys()], "no edge kept for the old key").not.toContain(oldBob);
    const row = (bob.groups as unknown as { stored: Map<string, { owedBye?: unknown }> }).stored.get(id);
    expect(row?.owedBye, "the leave, heard, is no longer kept").toBeUndefined();
  });
});
