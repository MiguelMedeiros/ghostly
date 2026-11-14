import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.join, groups.admin-change

/**
 * An online admin whose app is no hub still lets people in (WISP 903 § Admissions while the admin is away). Only hubs
 * answer knocks, so an admin's app that was no hub (the role handed to a member) let nobody in while it was open: the
 * hubs, members now (the one that handed the role on included), stopped at the 32 admissions in a row the admin's
 * absence allows them, and whoever opened the link after that waited for good (bug hunt, 2026-11-12: 40 members, the
 * role handed to a member, then 50 opening the link: 32 let in, 18 knocking 20 minutes later). The admin's app steps up
 * as a hub while the members' admissions wait for it.
 */
type Live = { hub: boolean };
const liveOf = (p: Peer, id: string) => (p.groups.communities as unknown as { live: Map<string, Live> }).live.get(id);

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

/** A community of 8 built through its link, the role handed to a member that is no hub. */
async function handedOn(seed: number) {
  const world = new CommunityWorld(undefined, null, seededRandom(seed));
  restore = sameRun(world, seed);
  const first = world.add("first");
  const id = await first.groups.create("Crowd");
  const link = await first.groups.enableLink(id);
  await world.run(5_000);
  const members = Array.from({ length: 7 }, (_, i) => world.add(`m${i}`));
  for (const p of members) await p.groups.joinByLink(link);
  await world.until(() => members.every(p => world.member(p, id)), 10 * 60_000);
  await world.run(2 * 60_000);
  const admin = members.find(p => !liveOf(p, id)?.hub)!;
  await first.groups.makeAdmin(id, world.view(admin, id)!.myKey!);
  await world.until(() => !!admin.groups.communities.session(id)?.isAdmin, 5 * 60_000);
  await world.run(60_000);
  expect(liveOf(admin, id)!.hub).toBe(false);
  return { world, admin, id, link };
}

/** `count` people open the link, one a second; then the world runs until all are in or `limitMs` passed. */
async function storm(world: CommunityWorld, id: string, link: string, count: number, limitMs: number) {
  const joiners: Peer[] = [];
  for (let i = 0; i < count; i++) {
    const p = world.add(`s${i}`);
    joiners.push(p);
    await p.groups.joinByLink(link);
    await world.run(1_000);
  }
  await world.until(() => joiners.every(p => world.member(p, id)), limitMs).catch(() => undefined);
  return joiners.filter(p => world.member(p, id)).length;
}

describe("an online admin whose app is no hub", { timeout: 600_000 }, () => {
  for (const seed of [11, 22]) {
    it(`lets in all of 40 opening the link, past the members' 32 in a row (seed ${seed})`, async () => {
      const { world, admin, id, link } = await handedOn(seed);
      expect(await storm(world, id, link, 40, 20 * 60_000)).toBe(40);
      expect(world.view(admin, id)!.members.length).toBe(48);
    });
  }

  it("with the admin's app closed, members still stop at 32 admissions in a row (control)", async () => {
    const { world, admin, id, link } = await handedOn(11);
    admin.online = false;
    expect(await storm(world, id, link, 40, 10 * 60_000)).toBe(COMMUNITY_LIMITS.memberAdmissions);
  });
});
