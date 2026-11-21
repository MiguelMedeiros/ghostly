import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.join

/**
 * Admissions while the admin is away (WISP 903): once members signed `COMMUNITY_LIMITS.memberAdmissions` in a row, a
 * member's hub cannot let anyone else in until the admin does. It used to answer every knock all the same: an entry
 * session, `group-invite`, the joiner shown "getting the group's keys, you are in in a moment", then `admit` refused
 * the accept and the session closed with nothing said, every turn of the door, for as long as the admin was away.
 */
const BOUND = COMMUNITY_LIMITS.memberAdmissions;
afterEach(() => { COMMUNITY_LIMITS.memberAdmissions = BOUND; });

describe("a community at the member admissions bound", { timeout: 120_000 }, () => {
  it("opens no entry session for a new key while the admin is away, and the admin lets the joiner in once back", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const id = await alice.groups.create("Bound");
    const link = await alice.groups.enableLink(id);
    await world.run(5_000);
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 2 * 60_000);
    await world.run(3 * 60_000, 1_000);
    // The admin's app closes; one admission by a member is the bound here.
    COMMUNITY_LIMITS.memberAdmissions = 1;
    alice.online = false;
    const carol = world.add("carol");
    await carol.groups.joinByLink(link);
    await world.until(() => world.member(carol, id), 5 * 60_000);
    // The bound is reached: the next joiner is not invited by a member's hub (nor told it is let in).
    const invited: string[] = [];
    world.drop = (from, to, frame) => { if (to.name === "dave" && frame.t === "group-invite") invited.push(from.name); return false; };
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    await world.run(15 * 60_000, 1_000);
    expect(invited).toEqual([]);
    expect(world.member(dave, id)).toBe(false);
    expect(world.view(dave, id)?.invitation?.stage).not.toBe("admitted");
    // The admin is back: it lets the joiner in.
    world.reopen(alice);
    await world.until(() => world.member(dave, id), 10 * 60_000);
    expect(invited).toContain("alice");
  });
});
