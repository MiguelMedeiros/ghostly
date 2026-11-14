import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_TOPOLOGY } from "@ghostly/core";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * A hub whose members fill it (`hubCapacity`) still answers the knocks of its turn at the door (WISP 903 § Admission
 * through the link): an admission is a commit, and the newcomer takes its edge from a hub with room. It let the next
 * hub in turn answer instead, two minutes later, and the next one was as full: past about 100 members, with the hubs
 * that had been the door full, a community let in one to three people a minute (`npm run test:group-load` stopped at
 * 129 of 256). Here the hubs hold six members each, so they fill at a few dozen.
 */
const CAPACITY = 6;
const topology = COMMUNITY_TOPOLOGY as { hubCapacity: number };
const hubCapacity = topology.hubCapacity;
type Live = { members: Map<string, number> };
const liveOf = (p: Peer, id: string) => (p.groups.communities as unknown as { live: Map<string, Live> }).live.get(id);

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; topology.hubCapacity = hubCapacity; });

describe("a full hub at the door", { timeout: 600_000 }, () => {
  for (const seed of [11, 22, 33]) {
    it(`lets a wave of joiners in at once, the admin away (seed ${seed})`, async () => {
      topology.hubCapacity = CAPACITY;
      const world = new CommunityWorld(undefined, null, seededRandom(seed));
      restore = sameRun(world, seed);
      const admin = world.add("admin");
      const id = await admin.groups.create("Crowd");
      const link = await admin.groups.enableLink(id);
      await world.run(5_000);
      for (let i = 1; i < 24; i += 8) {
        const wave = Array.from({ length: 8 }, (_, j) => world.add(`p${i + j}`));
        for (const p of wave) await p.groups.joinByLink(link);
        await world.until(() => wave.every(p => world.member(p, id)), 10 * 60_000, 1000, () => `wave ${i}: ${wave.filter(p => !world.member(p, id)).map(p => p.name).join(",")}`);
      }
      // The admin's app closes; its members move to the hubs left, which fill.
      admin.online = false;
      await world.run(5 * 60_000);
      const hubs = [...world.peers.values()].filter(p => p.online && p.groups.communities.isHub(id));
      expect(hubs.filter(p => (liveOf(p, id)?.members.size ?? 0) >= CAPACITY).length).toBeGreaterThan(0);
      const wave = Array.from({ length: 8 }, (_, j) => world.add(`q${j}`));
      for (const p of wave) await p.groups.joinByLink(link);
      const ms = await world.until(() => wave.every(p => world.member(p, id)), 15 * 60_000, 1000, () => `late wave: ${wave.filter(p => !world.member(p, id)).map(p => p.name).join(",")}`);
      console.log(`seed ${seed}: 8 let in after ${Math.round(ms / 1000)} s; hubs ${hubs.map(p => liveOf(p, id)?.members.size).join("/")}`);
      // The door answers at once, one joiner after the other: well within the two minutes a turn of the next hub took.
      expect(ms).toBeLessThan(90_000);
      for (const p of hubs) expect(liveOf(p, id)!.members.size).toBeLessThanOrEqual(CAPACITY);
    });
  }
});
