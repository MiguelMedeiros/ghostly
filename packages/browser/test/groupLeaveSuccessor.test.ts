import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.leave, groups.community.leave

/** An admin's leave hands the role on, and says to whom, so the CLI can name the new admin (a member's names nobody). */
describe("the member a leaving admin hands the role to", { timeout: 300_000 }, () => {
  for (const mode of ["mesh", "community"] as const) {
    it(`${mode}: the admin's leave answers the new admin's key; a member's leave answers none`, async () => {
      const world = mode === "mesh" ? new CommunityWorld(undefined, null) : new CommunityWorld();
      const peers = ["alice", "bob", "carol"].map(n => world.add(n));
      const [alice, bob, carol] = peers;
      const id = mode === "mesh" ? await alice.groups.create("Turns", mode) : await alice.groups.create("Turns");
      const link = await alice.groups.enableLink(id);
      for (const p of [bob, carol]) await p.groups.joinByLink(mode === "mesh" ? link : `https://app.ghostly.tools/#/join/${link}`);
      await world.until(() => peers.every(p => mode === "mesh" ? world.view(p, id)?.members.length === 3 : world.member(p, id)), 20 * 60_000);
      await world.run(20_000);
      const carolKey = world.view(carol, id)!.myKey!;
      expect(await carol.groups.leave(id)).toBeUndefined();
      await world.until(() => !world.view(alice, id)?.members.some(m => m.key === carolKey), 2 * 60_000);
      const next = await alice.groups.leave(id);
      expect(next).toBe(world.view(bob, id)!.myKey);
      await world.until(() => world.view(bob, id)?.isAdmin === true, 2 * 60_000);
    });
  }
});
