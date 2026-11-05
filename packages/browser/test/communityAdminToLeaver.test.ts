import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.leave, groups.admin-change

/**
 * The community counterpart of groupAdminToLeaver.test.ts: the admin role went to a member whose leave request was on its
 * way when the admin signed the hand-over: the admin made a member the admin while that member left, or the admin left
 * and the member its app picked left at the same moment. The leaver's app had forgotten the group, and nobody commits a
 * leave that names the admin, so the group kept for good an admin that had left: nobody could remove, change the link
 * or rename again.
 */
describe("a community's admin role handed to a member whose leave is on its way", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  async function group(seed: number) {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const peers = ["carol", "bob", "dave", "erin"].map(n => world.add(n));
    const [carol, ...rest] = peers;
    const id = await carol.groups.create("Race");
    const link = await carol.groups.enableLink(id);
    for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === 4), 2 * 60_000);
    await world.run(20_000);
    const keyOf = new Map(peers.map(p => [world.view(p, id)!.myKey!, p] as const));
    const key = (p: Peer) => [...keyOf].find(([, q]) => q === p)![0];
    return { world, id, peers, carol, key, peerOf: (k: string) => keyOf.get(k)! };
  }

  /** The ones left have one live admin among them and a roster of just them, and that admin can still do an admin's work. */
  async function converged(world: CommunityWorld, id: string, stay: Peer[], key: (p: Peer) => string): Promise<void> {
    const want = stay.map(key).sort();
    const what = () => stay.map(p => { const v = world.view(p, id); return `${p.name}: ${v?.status} e=${v?.epoch} admin=${v?.members.find(m => m.role === "admin")?.key.slice(0, 6)} n=${v?.members.length}`; }).join(" | ");
    await world.until(() => stay.every(p => {
      const v = world.view(p, id);
      return v?.status === "active" && JSON.stringify(v.members.map(m => m.key).sort()) === JSON.stringify(want) && want.includes(v.members.find(m => m.role === "admin")?.key ?? "");
    }), 5 * 60_000, 1000, what);
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
    it(`seed ${seed}: the admin makes a member the admin while that member leaves`, async () => {
      const { world, id, peers, carol, key } = await group(seed);
      const bob = peers[1];
      await Promise.allSettled([carol.groups.makeAdmin(id, key(bob)), bob.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== bob), key);
    });

    it(`seed ${seed}: the admin leaves and the member its app picked leaves at the same moment`, async () => {
      const { world, id, peers, carol, key, peerOf } = await group(seed);
      const next = peerOf(carol.groups.successor(id)!);
      await Promise.allSettled([carol.groups.leave(id), next.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== carol && p !== next), key);
    });

    it(`seed ${seed}: control, the member leaves a second after the role reached it`, async () => {
      const { world, id, peers, carol, key } = await group(seed);
      const bob = peers[1];
      await carol.groups.makeAdmin(id, key(bob));
      await world.run(1_000);
      await bob.groups.leave(id);
      await converged(world, id, peers.filter(p => p !== bob), key);
    });
  }
});
