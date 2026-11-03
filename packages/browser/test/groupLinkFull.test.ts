import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_MEMBER_CAP, LEGACY_GROUP_MEMBERS } from "@ghostly/core";
import type { StoredGroup } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.entry

/**
 * A private group with no room (WISP 902 § A full group): its admin's app answers a knock all the same, with
 * `group-full` in place of `group-invite`, at most every five minutes per joiner, and the joiner's view says why it
 * waits (full, or waiting for everyone to update) rather than leaving it on "knocked", whose page, after two minutes,
 * sends the person to ask for a new link that would not help.
 */
const CAP = GROUP_MEMBER_CAP.max;
afterEach(() => { GROUP_MEMBER_CAP.max = CAP; vi.restoreAllMocks(); });

async function group(world: CommunityWorld, members: number): Promise<{ id: string; link: string; admin: Peer; joined: Peer[] }> {
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  const admin = world.add("admin");
  const id = await admin.groups.create("Door", "mesh");
  const link = await admin.groups.enableLink(id);
  const joined: Peer[] = [];
  for (let i = 0; i < members; i++) {
    const p = world.add(`m${i}`);
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 3 * 60_000);
    joined.push(p);
  }
  return { id, link, admin, joined };
}

describe("a private group's link with no room", { timeout: 120_000 }, () => {
  it("full: tells a knocking joiner (n of max), at most every five minutes, and lets it in once someone leaves", async () => {
    const world = new CommunityWorld();
    const { id, link, joined } = await group(world, 2);
    GROUP_MEMBER_CAP.max = 3;
    const told: number[] = [];
    world.drop = (_, to, frame) => { if (to.name === "dave" && frame.t === "group-full") told.push(world.now); return false; };
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    await world.until(() => world.view(dave, id)?.invitation?.stage === "full", 2 * 60_000);
    expect(world.view(dave, id)?.invitation).toMatchObject({ stage: "full", full: { n: 3, max: 3 } });
    await world.run(11 * 60_000, 1_000);
    expect(told.length).toBeGreaterThanOrEqual(2);
    expect(told.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < told.length; i++) expect(told[i] - told[i - 1]).toBeGreaterThanOrEqual(5 * 60_000);
    expect(world.view(dave, id)?.invitation?.stage).toBe("full");
    await joined[1].groups.leave(id);
    await world.until(() => world.member(dave, id), 7 * 60_000);
    expect(world.view(dave, id)?.invitation).toBeUndefined();
  });

  it("past eight with a member not seen updated: tells the joiner it waits for an update (blocked)", async () => {
    const world = new CommunityWorld();
    const { id, link, admin } = await group(world, LEGACY_GROUP_MEMBERS - 1);
    // One member's app has not said it takes a roster past eight.
    const stored = (admin.groups as unknown as { stored: Map<string, StoredGroup> }).stored.get(id)!;
    stored.large = stored.large!.slice(1);
    const dave = world.add("dave");
    await dave.groups.joinByLink(link);
    await world.until(() => world.view(dave, id)?.invitation?.stage === "blocked", 2 * 60_000);
    expect(world.view(dave, id)?.invitation?.full).toMatchObject({ n: LEGACY_GROUP_MEMBERS, max: CAP });
  });
});
