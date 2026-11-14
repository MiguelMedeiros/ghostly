import { describe, expect, it } from "vitest";
import { communityCommitHash, communityRoster, communityUntaggedHash, confirmationTag, epochKeys, identityFromSeedB64, newEpochSecret, rosterHash, signCommunity } from "@ghostly/core";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.join

/**
 * A member whose community forked (the admin signed two different changes after one commit: a second or restored
 * device) and who opens the group's link again: the link never deletes what is kept. As for a private group, it is
 * refused with the line that says the history is still here, and the group stays as it was.
 */
describe("a forked community's link opened again", () => {
  it("is refused, and the history kept on the device stays", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const id = await alice.groups.create("Town");
    const link = await alice.groups.enableLink(id);
    for (const p of [bob, carol]) {
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 120_000);
    }
    for (const text of ["the plan for friday", "bring the keys"]) await alice.groups.send(id, text);
    await bob.groups.send(id, "bob's own line");
    await world.run(5_000);

    // The admin's second device signs another change after the same commit (as core's groupCommunity fork test does).
    const s = alice.groups.communities.session(id)!;
    const parent = s.top, seed = identityFromSeedB64(s.state.seedB64).seed;
    const base = { v: 2 as const, g: parent.g, e: parent.e + 1, p: communityCommitHash(parent), ts: world.now, by: s.myKey };
    const draft = { ...base, k: "rotate" as const, m: rosterHash(communityRoster(s.roster, { ...base, k: "rotate" })!) };
    const other = signCommunity({ ...draft, c: confirmationTag(epochKeys(newEpochSecret(), parent.g, draft.e).confirm, communityUntaggedHash(draft)) }, seed);
    await alice.groups.rotate(id);
    await world.run(3_000);
    await bob.groups.handleEdgeFrame(id, s.myKey, { t: "group-commit", v: 2, g: id, commit: structuredClone(other) });
    await world.settle();
    expect(world.view(bob, id)?.status).toBe("forked");
    const before = world.texts(bob, id);
    expect(before).toEqual(expect.arrayContaining(["the plan for friday", "bring the keys", "bob's own line"]));

    await expect(bob.groups.joinByLink(link)).rejects.toThrow("You are out of this group and its history is still here. Delete it from this device to join with a link.");
    await world.settle();
    expect(world.view(bob, id)?.status).toBe("forked");
    expect(world.texts(bob, id)).toEqual(before);
  });
});
