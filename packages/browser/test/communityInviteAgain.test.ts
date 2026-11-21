import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.join

/**
 * A hub invites a joiner once, when the entry session comes up (`entryReady`). A joiner that let another member's invite
 * in a moment before ignores every other member's for `ENTRY_LINGER_MS` (one admission at a time on its session), and
 * that member's `admit` may then fail (the members at their bound, `admissionsHeld`): the session stayed up with nothing
 * coming, the hub dropped it after `ENTRY_TIMEOUT_MS` and refused that joiner for `REFUSED_FOR_MS` (the admin's app
 * opened for the members at their bound: three joiners pending 180 s on it, then refused 597 s, the wave 856 s at 256
 * members). An invite nobody answered here is the one invite the joiner did not take.
 */
describe("an invite the joiner did not answer", { timeout: 120_000 }, () => {
  it("is sent again on the up session, and the joiner gets in", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const id = await alice.groups.create("Again");
    const link = await alice.groups.enableLink(id);
    await world.run(5_000);
    const invites: number[] = [];
    world.drop = (from, to, frame) => {
      if (from.name !== "alice" || to.name !== "dave" || frame.t !== "group-invite") return false;
      invites.push(world.now);
      return invites.length === 1;
    };
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    await world.until(() => world.member(dave, id), 2 * 60_000);
    expect(invites.length).toBe(2);
    expect(invites[1] - invites[0]).toBeLessThan(40_000);
  });
});
