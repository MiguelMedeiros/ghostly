import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom } from "./communityWorld";
// covers: groups.community.join, groups.protocol.community-topology

/**
 * A member hub's app was off the network (still open, no restart) while the admin replaced the community's link, and
 * someone knocked on the old one. Back online, the hub answered that knock before it heard the new link, and its welcome
 * handed over the rendezvous secret, the roster and the names. A hub back from a while away is at the door again only
 * once it has caught up with a member (or, alone, read the beacon), as an app back from a restart is.
 */
describe("a hub back from a while away", { timeout: 600_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it("lets nobody in on a link replaced while it was away", async () => {
    let raced = 0;
    for (const seed of [100, 103]) {
      const world = new CommunityWorld(undefined, null, seededRandom(seed));
      restore = sameRun(world, seed);
      const names = ["alice", "bob", "carol", "dave", "erin", "fred", "gina", "hank", "ivan"];
      const peers = names.map(n => world.add(n));
      const [alice, ...rest] = peers;
      const id = await alice.groups.create("Old link");
      const link = await alice.groups.enableLink(id);
      for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
      await world.until(() => peers.every(p => world.view(p, id)?.members.length === names.length), 3 * 60_000);
      await world.run(60_000);
      const hub = rest.find(p => p.groups.communities.isHub(id));
      if (!hub) continue;
      raced++;
      hub.online = false;
      await world.run(2 * 60_000);
      const fresh = await alice.groups.enableLink(id, true);
      await world.run(5_000);
      const zed = world.add("zed");
      await zed.groups.joinByLink(link);
      await world.run(10_000);
      world.reopen(hub);
      await world.run(2 * 60_000);
      expect(world.member(zed, id), `seed ${seed}`).toBe(false);
      expect(world.view(hub, id)?.entryLink, `seed ${seed}`).toBe(world.view(alice, id)?.entryLink);
      // The door works again: the new link lets someone in.
      const yan = world.add("yan");
      await yan.groups.joinByLink(fresh);
      await world.until(() => world.member(yan, id), 3 * 60_000);
      restore?.(); restore = null;
    }
    expect(raced).toBeGreaterThan(0);
  });
});
