import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom } from "./communityWorld";
// covers: groups.leave

/**
 * A member's leave request lost on the way (Leave pressed as the phone's network changes, its data channel still looking
 * ready): it went once, on the one edge up, and its app had forgotten the group. Nobody asked for it again, and the member
 * stayed in every roster for good, though its app, still following the chain, held the request and saw it still in.
 */
describe("a member's leave request lost on the way", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  // `down`: its edges then dead a while, as a phone's are while the network changes (under the minute its hub keeps them).
  for (const kind of ["community", "mesh"] as const) for (const seed of [11, 22, 33]) for (const down of [0, 30_000]) {
    it(`${kind}, seed ${seed}: is said again until a commit takes the member out${down ? ", its edges down 30 s after" : ""}`, async () => {
      const world = new CommunityWorld(undefined, null, seededRandom(seed));
      restore = sameRun(world, seed);
      const peers = ["admin", "bob", "carol", "dave"].map(n => world.add(n));
      const [admin, bob] = peers, stay = peers.filter(p => p !== bob);
      const id = await admin.groups.create("Leave", kind === "mesh" ? "mesh" : undefined);
      const link = await admin.groups.enableLink(id);
      for (const p of peers.slice(1)) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
      await world.until(() => peers.every(p => world.view(p, id)?.members.length === 4), 5 * 60_000);
      await world.run(20_000);
      const bobKey = world.view(bob, id)!.myKey!;
      let sent = 0, dropped = 0;
      // Bob's first leave frame is lost on the wire.
      world.drop = (from, _to, frame) => {
        if (from !== bob || (frame.t !== "group-leave" && frame.t !== "group-bye") || (frame.s !== undefined && frame.s !== bobKey)) return false;
        sent++;
        if (dropped) return false;
        dropped++;
        return true;
      };
      await bob.groups.leave(id);
      expect(world.view(bob, id)).toBeUndefined();
      // The network changed under bob's app: its data channels were dead, and come back a while after.
      if (down) { world.cut = (a, b) => a === bob || b === bob; await world.run(down); world.cut = null; }
      await world.run(12 * 60_000 - down);
      const what = stay.map(p => `${p.name}: n=${world.view(p, id)?.members.length}`).join(" | ") + ` sent=${sent}`;
      expect(dropped, what).toBe(1);
      for (const p of stay) expect(world.view(p, id)!.members.map(m => m.key), what).not.toContain(bobKey);
    });
  }
});
