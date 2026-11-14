import { describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * The admin, cut off from the others, replaces the link while a hub at the door lets Dave in through the old one. When
 * the two sides meet, the admin's `link` commit wins (WISP 903 § Races and forks, rule 1) and Dave's admission loses.
 * The commit that makes it lose carries the new link, so no member sends it to him: he is not told, holds nothing that
 * names the new link, and is let in only once given the current one. The control: the admin's change is a rotation,
 * the link is the same, and Dave's knock there is answered.
 */
describe("a newcomer whose admission lost to the admin's change made while cut off", { timeout: 300_000 }, () => {
  for (const seed of [11, 22, 33]) for (const change of ["link", "rotate"] as const) it(`${change === "link" ? "is not handed the new link" : "is let in again at the same link"} (seed ${seed})`, async () => {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    const restore = sameRun(world, seed);
    try {
      const [admin, bob, carol] = ["admin", "bob", "carol"].map(n => world.add(n));
      const id = await admin.groups.create("Door");
      const link = await admin.groups.enableLink(id);
      for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
      await world.run(60_000);
      world.part = (p: Peer) => p === admin ? 0 : 1;
      await world.run(60_000);
      const newest = change === "link" ? await admin.groups.enableLink(id, true) : (await admin.groups.rotate(id), link);
      const dave = world.add("dave");
      await dave.groups.joinByLink(link);
      await world.until(() => world.member(dave, id) && world.view(bob, id)?.members.length === 4, 5 * 60_000);
      await bob.groups.send(id, "welcome dave");
      await world.until(() => world.texts(dave, id).includes("welcome dave"), 60_000);
      const inAdmin = () => world.view(admin, id)!.members.length === 4;

      world.part = null;
      if (change === "rotate") { await world.until(() => world.member(dave, id) && inAdmin(), 5 * 60_000); return; }
      // The link commit is what makes his admission lose, and it carries the new link: no member hands it to him, so he
      // is not told he lost, and nothing he holds names the new link. He is not let in through it on his own.
      const entry = admin.groups.communities.session(id)!.entryKey;
      await world.run(30 * 60_000);
      expect(entry).not.toBe("");
      expect(JSON.stringify(dave.groups.communities.session(id)!.state)).not.toContain(entry);
      expect(inAdmin()).toBe(false);
      // Given the current link, he deletes the group here and opens it: he is back in.
      await dave.groups.forget(id);
      await dave.groups.joinByLink(newest);
      await world.until(() => world.member(dave, id) && inAdmin(), 5 * 60_000);
    } finally { restore(); }
  });
});
