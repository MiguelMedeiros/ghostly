import { afterEach, describe, expect, it } from "vitest";
import { GROUP_MEMBER_CAP } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.link.join, groups.protocol.entry

/**
 * A full private group (WISP 902 § A full group): its admin's app answers a knock all the same, opening the entry
 * session and sending `group-full` in place of `group-invite`, at most every five minutes per joiner, and the joiner's
 * view says it is full rather than staying on "knocked" (whose page, after two minutes, sends the person to ask for a
 * new link that would not help). Once there is room, the next answer is an ordinary invitation.
 */
const CAP = GROUP_MEMBER_CAP.max;
afterEach(() => { GROUP_MEMBER_CAP.max = CAP; });

async function full(world: CommunityWorld): Promise<{ id: string; link: string; alice: Peer; members: Peer[] }> {
  const alice = world.add("alice");
  const id = await alice.groups.create("Full", "mesh");
  const link = await alice.groups.enableLink(id);
  const members = [world.add("bob"), world.add("carol")];
  for (const p of members) {
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 3 * 60_000);
  }
  await world.run(20_000);
  // The cap, which the engine reads live: three is full.
  GROUP_MEMBER_CAP.max = 3;
  return { id, link, alice, members };
}

describe("a full private group's link", { timeout: 120_000 }, () => {
  it("tells a knocking joiner it is full (n of max), and lets it in once someone leaves", async () => {
    const world = new CommunityWorld(undefined, null);
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

  it("past eight while a member's app is not seen updated, tells the joiner it waits for that (blocked)", async () => {
    const world = new CommunityWorld(undefined, null);
    const alice = world.add("alice");
    const id = await alice.groups.create("Eight", "mesh");
    const link = await alice.groups.enableLink(id);
    const members = ["bob", "carol", "dave", "erin", "frank", "grace", "hank"].map(n => world.add(n));
    for (const p of members) {
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 3 * 60_000);
    }
    await world.run(20_000);
    // Bob's app as the admin's knows it: not seen taking a roster past eight.
    const stored = (alice.groups as unknown as { stored: Map<string, { large?: string[] }> }).stored.get(id)!;
    const bob = world.view(members[0], id)!.myKey!, large = stored.large ?? [];
    stored.large = large.filter(key => key !== bob);
    const ivy = world.add("ivy");
    await ivy.groups.joinByLink(link);
    await world.until(() => world.view(ivy, id)?.invitation?.stage === "blocked", 2 * 60_000);
    expect(world.view(ivy, id)?.invitation).toMatchObject({ stage: "blocked", full: { n: 8, max: GROUP_MEMBER_CAP.max } });
    // Bob's app is seen updated: the next answer is an ordinary invitation.
    stored.large = large;
    await world.until(() => world.member(ivy, id), 7 * 60_000);
  });

  it("takes no answer whose numbers cannot be (more members than it holds, or past the cap)", async () => {
    const world = new CommunityWorld(undefined, null);
    const { id, link } = await full(world);
    const said = [{ n: Number.MAX_SAFE_INTEGER, max: 1 }, { n: 4, max: 3 }, { n: 2, max: GROUP_MEMBER_CAP.max + 1 }];
    let told = 0;
    world.drop = (_, to, frame) => { if (to.name === "dave" && frame.t === "group-full") Object.assign(frame, said[told++ % said.length]); return false; };
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    while (told < said.length) {
      await world.run(30_000, 1_000);
      expect(world.view(dave, id)?.invitation?.full).toBeUndefined();
    }
  });
});
