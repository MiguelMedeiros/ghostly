import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom } from "./communityWorld";
// covers: groups.protocol.entry

/**
 * A member picks Delete on a private group it is active in while the admin's app is closed. Delete left the group and
 * then dropped the tombstone that was to say the leave once the admin is back, so nothing on the device remembered it:
 * the admin and every member kept the person in the roster for good. Leave kept it, and its leave reached them.
 */
describe("Delete on an active group while the admin's app is closed", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  for (const how of ["forget", "leave"] as const) {
    for (const seed of [11, 22, 33]) {
      it(`${how === "forget" ? "Delete" : "Leave"} takes the member out of every roster once the admin is back (seed ${seed})`, async () => {
        const world = new CommunityWorld(undefined, null, seededRandom(seed));
        restore = sameRun(world, seed);
        const [admin, bob, carol, dave] = ["admin", "bob", "carol", "dave"].map(n => world.add(n));
        const id = await admin.groups.create("Mesh", "mesh");
        const link = await admin.groups.enableLink(id);
        for (const p of [bob, carol, dave]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
        await world.until(() => [admin, bob, carol, dave].every(p => world.view(p, id)!.members.length === 4), 2 * 60_000);
        const carolKey = world.view(carol, id)!.myKey!;
        const roster = (p: typeof admin) => world.view(p, id)!.members.map(m => m.key);
        for (const p of [admin, bob, dave]) expect(roster(p), "carol is in every roster before").toContain(carolKey);

        admin.online = false;
        await world.run(5_000);
        if (how === "forget") await carol.groups.forget(id); else await carol.groups.leave(id);
        expect(world.view(carol, id), "the group is gone from carol's list").toBeUndefined();
        await world.run(30_000);
        world.reopen(admin);
        await world.run(10 * 60_000);

        expect(roster(admin), "the admin took carol out").not.toContain(carolKey);
        expect(roster(bob), "bob took carol out").not.toContain(carolKey);
        expect(roster(dave), "dave took carol out").not.toContain(carolKey);
        const stored = (carol.groups as unknown as { stored: Map<string, unknown> }).stored;
        expect(stored.has(id), "the tombstone goes once the admin heard the leave").toBe(false);
      });
    }
  }
});
