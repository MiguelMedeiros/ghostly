import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.leave, groups.admin-change

/**
 * The admin made a member the admin while that member left: the leaver's app follows the group's chain a while and
 * hands the role on (communityAdminToLeaver.test.ts). Three ordinary things ended that follow before the hand-on, and
 * the group kept the departed key as its admin for good: the member opened the group's link again, its app restarted,
 * or its app was closed and opened again later; or the one frame that made it the admin was lost on the way. Nobody
 * could remove, rename or change the link any more.
 */
describe("a community's admin role that reached a leaver whose app moves on", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  async function group(seed: number, names = ["carol", "bob", "dave", "erin", "fay"]) {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const peers = names.map(n => world.add(n));
    const [carol, ...rest] = peers;
    const id = await carol.groups.create("Race");
    const link = await carol.groups.enableLink(id);
    for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === names.length), 2 * 60_000);
    await world.run(20_000);
    const key = (p: Peer) => world.view(p, id)!.myKey!;
    return { world, id, link, peers, carol, bob: peers[1], key };
  }

  /**
   * The ones in the group agree on a roster of just them (the leaver's old key out), one of them is the admin, and that
   * admin can rename, show the link and remove a member, which everyone sees.
   */
  async function converged(world: CommunityWorld, id: string, stay: Peer[], gone: string): Promise<void> {
    const key = (p: Peer) => world.view(p, id)?.myKey ?? "";
    const what = () => stay.map(p => { const v = world.view(p, id); return `${p.name}: ${v?.status} e=${v?.epoch} admin=${v?.members.find(m => m.role === "admin")?.key.slice(0, 6)} n=${v?.members.length} old=${v?.members.some(m => m.key === gone)}`; }).join(" | ");
    await world.until(() => stay.every(p => {
      const v = world.view(p, id), want = stay.map(key).sort();
      return v?.status === "active" && JSON.stringify(v.members.map(m => m.key).sort()) === JSON.stringify(want) && want.includes(v.members.find(m => m.role === "admin")?.key ?? "");
    }), 5 * 60_000, 1000, what);
    for (const p of stay) expect(world.view(p, id)!.members.some(m => m.key === gone), p.name).toBe(false);
    const admins = stay.filter(p => world.view(p, id)!.isAdmin);
    expect(admins.length, what()).toBe(1);
    const admin = admins[0], other = stay.find(p => p !== admin)!;
    await admin.groups.rename(id, "Still here");
    expect(await admin.groups.enableLink(id)).toBeTruthy();
    await admin.groups.remove(id, key(other));
    const left = stay.filter(p => p !== other);
    await world.until(() => left.every(p => world.view(p, id)?.name === "Still here" && world.view(p, id)!.members.length === left.length), 2 * 60_000, 1000, what);
  }

  for (const seed of [11, 22, 33]) {
    it(`seed ${seed}: the leaver opens the group's link again before its app handed the role on`, async () => {
      const { world, id, link, peers, carol, bob, key } = await group(seed);
      const old = key(bob);
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      await bob.groups.joinByLink(link);
      await world.until(() => world.member(bob, id) && world.view(bob, id)!.myKey !== old, 5 * 60_000);
      await converged(world, id, peers, old);
    });

    // The role's commit to the leaver's app was lost on the way, and came again only on its asking.
    it(`seed ${seed}: the leaver opens the group's link again while the role is still on its way to it`, async () => {
      const { world, id, link, peers, carol, bob, key } = await group(seed);
      const old = key(bob), until = world.now + 20_000;
      world.drop = (_from, to, frame) => to === bob && world.now < until && frame.t === "group-commit" && (frame.commit as { k?: string }).k === "role";
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      await world.run(10_000);
      await bob.groups.joinByLink(link);
      await world.until(() => world.member(bob, id) && world.view(bob, id)!.myKey !== old, 5 * 60_000);
      await converged(world, id, peers, old);
    });

    // Nobody sends that commit again on their own: the leaver's app, still in the roster, asks where the chain stands.
    it(`seed ${seed}: the one frame of the role to the leaver's app is lost`, async () => {
      const { world, id, peers, carol, bob, key } = await group(seed);
      const old = key(bob), lost: string[] = [];
      world.drop = (from, to, frame) => {
        if (lost.length || to !== bob || frame.t !== "group-commit" || (frame.commit as { k?: string }).k !== "role") return false;
        lost.push(from.name);
        return true;
      };
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== bob), old);
      expect(lost).toHaveLength(1);
    });

    it(`seed ${seed}: control, the leaver opens the group's link again 3 s after its app handed the role on`, async () => {
      const { world, id, link, peers, carol, bob, key } = await group(seed);
      const old = key(bob);
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      await world.run(3_000);
      await bob.groups.joinByLink(link);
      await world.until(() => world.member(bob, id) && world.view(bob, id)!.myKey !== old, 5 * 60_000);
      await converged(world, id, peers, old);
    });

    it(`seed ${seed}: the leaver's app restarts before it handed the role on`, async () => {
      const { world, id, peers, carol, bob, key } = await group(seed);
      const old = key(bob);
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      await world.restart(bob);
      await converged(world, id, peers.filter(p => p !== bob), old);
      expect(world.view(bob, id)).toBeUndefined();
      // Its follow is over: nothing of it is kept any more, and its edges are gone.
      expect(await bob.store.getGroupsLeft!()).toEqual([]);
      expect([...bob.links.values()].filter(e => e.g === id)).toEqual([]);
    });

    it(`seed ${seed}: the leaver's app is closed before it handed the role on, and opened 2 minutes later`, async () => {
      const { world, id, peers, carol, bob, key } = await group(seed);
      const old = key(bob);
      await Promise.allSettled([carol.groups.makeAdmin(id, old), bob.groups.leave(id)]);
      bob.online = false;
      await world.run(2 * 60_000);
      await world.restart(bob);
      await converged(world, id, peers.filter(p => p !== bob), old);
      expect(world.view(bob, id)).toBeUndefined();
    });

    // Its follow had ended (`LEFT_FOLLOW_MS`): what was kept of it goes, and nothing follows again.
    it(`seed ${seed}: the leaver's app opened again after the follow's ten minutes takes nothing up`, async () => {
      const { world, id, carol, bob, key } = await group(seed);
      await Promise.allSettled([carol.groups.makeAdmin(id, key(bob)), bob.groups.leave(id)]);
      bob.online = false;
      expect(await bob.store.getGroupsLeft!()).toHaveLength(1);
      await world.run(11 * 60_000);
      await world.restart(bob);
      expect(await bob.store.getGroupsLeft!()).toEqual([]);
      expect(bob.groups.communities.has(id)).toBe(false);
    });
  }
});
