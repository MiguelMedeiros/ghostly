import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.send, groups.community.catch-up

/**
 * A community's session writes what it receives within a second (`persistSoon`). A clean stop (`Groups.flush`, as the
 * engine's shutdown calls it) wrote the private groups' sessions only: what a community took in its last second was
 * lost, and asked for again at the next start.
 */
describe("a community when the app stops", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps what it took just before a clean stop", async () => {
    const world = new CommunityWorld();
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Stops");
    await bob.groups.joinByLink(await alice.groups.enableLink(id));
    await world.until(() => world.member(bob, id), 5 * 60_000);
    await world.run(60_000);
    const aliceKey = alice.groups.communities.session(id)!.myKey;
    // What Bob's session saves by itself within a second is written before the message.
    await bob.groups.flush();
    expect(bob.groups.communities.session(id)!.state.seen[aliceKey]).toBeUndefined();

    await alice.groups.send(id, "just before the stop");
    await world.until(() => world.texts(bob, id).includes("just before the stop"), 60_000);
    await bob.groups.communityIdle();
    const seen = structuredClone(bob.groups.communities.session(id)!.state.seen[aliceKey]);
    expect(seen).toBeDefined();

    // Stopped at once, within the second its session waits before writing.
    await world.restart(bob);
    expect(bob.groups.communities.session(id)!.state.seen[aliceKey]).toEqual(seen);
  });
});
