import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * A full community's door (WISP 903 § A full community): it answers a knock all the same, with `group-full` in place of
 * `group-invite`, at most every five minutes per joiner, and the joiner's view says it is full rather than leaving it on
 * "knocked" (whose page, after two minutes, sends the person to ask for a new link that would not help).
 */
const MEMBERS = COMMUNITY_LIMITS.members;
afterEach(() => { COMMUNITY_LIMITS.members = MEMBERS; });

async function full(world: CommunityWorld): Promise<{ id: string; link: string; alice: Peer; members: Peer[] }> {
  const alice = world.add("alice");
  const id = await alice.groups.create("Full");
  const link = await alice.groups.enableLink(id);
  await world.run(5_000);
  const members = [world.add("bob"), world.add("carol")];
  for (const p of members) {
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 2 * 60_000);
  }
  // The hubs settle (who is at the door), then the cap, which the engine reads live: three is full.
  await world.run(3 * 60_000, 1_000);
  COMMUNITY_LIMITS.members = 3;
  return { id, link, alice, members };
}

describe("a full community's door", { timeout: 120_000 }, () => {
  it("tells a knocking joiner it is full (n of max), and lets it in once someone leaves", async () => {
    const world = new CommunityWorld();
    const { id, link, members } = await full(world);
    const told: number[] = [];
    world.drop = (_, to, frame) => { if (to.name === "dave" && frame.t === "group-full") told.push(world.now); return false; };
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    await world.until(() => world.view(dave, id)?.invitation?.stage === "full", 2 * 60_000);
    expect(world.view(dave, id)?.invitation).toMatchObject({ stage: "full", full: { n: 3, max: 3 } });
    // Told again at most every five minutes while it stays full; the joiner stays on "full" meanwhile.
    await world.run(11 * 60_000, 1_000);
    expect(told.length).toBeGreaterThanOrEqual(2);
    expect(told.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < told.length; i++) expect(told[i] - told[i - 1]).toBeGreaterThanOrEqual(5 * 60_000);
    expect(world.view(dave, id)?.invitation?.stage).toBe("full");
    // Someone leaves: the next answer is an ordinary invitation.
    await members[1].groups.leave(id);
    await world.until(() => world.member(dave, id), 7 * 60_000);
    expect(world.view(dave, id)?.invitation).toBeUndefined();
  });
});
