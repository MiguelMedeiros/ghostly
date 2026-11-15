import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: headless.group-call

/**
 * The node a community group's calls go through (WISP 602 § The group names its node), through the real community
 * engine on headless peers: the admin names it, every member's view carries it, a rename keeps it, sealed call media
 * goes on and off, clearing it clears it.
 */
describe("a group's call node on headless community engines", { timeout: 120_000 }, () => {
  it("set by the admin and seen by a member, kept through a rename, sealed and unsealed, cleared for everyone; refused to a member", async () => {
    const SFU = "https://call.example.com";
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Thursday");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(bob, id), 10 * 60_000);
    await world.run(20_000);

    await expect(bob.groups.setCall(id, SFU)).rejects.toThrow("Only the admin");
    await alice.groups.setCall(id, SFU);
    expect(world.view(alice, id)?.call).toEqual({ sfu: SFU });
    await world.until(() => world.view(bob, id)?.call?.sfu === SFU, 60_000);
    await alice.groups.rename(id, "Thursday call");
    await world.until(() => world.view(bob, id)?.name === "Thursday call", 60_000);
    expect(world.view(bob, id)?.call).toEqual({ sfu: SFU });
    // Sealed call media on; the node named again without a word on it keeps it on.
    await alice.groups.setCall(id, SFU, true);
    await world.until(() => world.view(bob, id)?.call?.e2ee === 1, 60_000);
    await alice.groups.setCall(id, SFU);
    expect(world.view(alice, id)?.call).toEqual({ sfu: SFU, e2ee: 1 });
    await alice.groups.setCall(id, SFU, false);
    await world.until(() => world.view(bob, id)?.call?.e2ee === undefined, 60_000);
    expect(world.view(bob, id)?.call).toEqual({ sfu: SFU });
    await alice.groups.setCall(id, null);
    await world.until(() => world.view(bob, id)?.call === undefined, 60_000);

    await expect(alice.groups.setCall("no-such-group", SFU)).rejects.toThrow("Group not found");
  });

  it("sealed before anyone joins (the e2e's order: create, call --e2ee, link): a member who joins later sees e2ee: 1", async () => {
    const SFU = "https://call.example.com";
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Thursday");
    await alice.groups.setCall(id, SFU, true);
    const link = await alice.groups.enableLink(id);
    expect(world.view(alice, id)?.call).toEqual({ sfu: SFU, e2ee: 1 });
    await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(bob, id), 10 * 60_000);
    await world.until(() => world.view(bob, id)?.call !== undefined, 60_000);
    expect(world.view(bob, id)?.call).toEqual({ sfu: SFU, e2ee: 1 });
  });
});
