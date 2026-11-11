import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type NetworkModel, type Peer } from "./communityWorld";
// covers: groups.leave, groups.admin-change

/**
 * agents#2890: in a private group the admin role went to a member whose own Leave was already under way, before that
 * member's app heard the `role` commit: the admin left and the member its app picked left at the same moment, or the
 * admin made a member the admin while that member left. The leaver's tombstone took only the commit removing it, so it
 * dropped the role, and its leave went to the old admin, who could no longer commit it. The group kept for good an
 * admin that had left, and two departed keys: nobody could remove, let in by the link, rename or leave.
 */
describe("the admin role handed to a member whose leave is under way", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  async function group(seed: number, names = ["alice", "bob", "carol", "dave"], network: NetworkModel | null = null) {
    const world = new CommunityWorld(undefined, network, seededRandom(seed));
    restore = sameRun(world, seed);
    const peers = names.map(n => world.add(n));
    const [alice, ...rest] = peers;
    const id = await alice.groups.create("Race", "mesh");
    const link = await alice.groups.enableLink(id);
    for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === names.length), 5 * 60_000);
    await world.run(network ? 60_000 : 20_000);
    const keyOf = new Map(peers.map(p => [world.view(p, id)!.myKey!, p] as const));
    const key = (p: Peer) => [...keyOf].find(([, q]) => q === p)![0];
    return { world, id, peers, alice, key, peerOf: (k: string) => keyOf.get(k)! };
  }

  const stored = (p: Peer, id: string) => (p.groups as unknown as { stored: Map<string, unknown> }).stored.get(id);

  /** The ones left have one live admin among them, and a roster of just them; the leavers' apps are done with the group. */
  async function converged(world: CommunityWorld, id: string, stay: Peer[], gone: Peer[], key: (p: Peer) => string): Promise<void> {
    const want = stay.map(key).sort();
    const what = () => stay.map(p => { const v = world.view(p, id); return `${p.name}: ${v?.status} e=${v?.epoch} admin=${v?.members.find(m => m.role === "admin")?.key.slice(0, 6)} n=${v?.members.length}`; }).join(" | ")
      + ` || gone: ${gone.map(p => `${p.name}=${stored(p, id) ? "tombstone" : "none"}`).join(" ")}`;
    await world.until(() => stay.every(p => {
      const v = world.view(p, id);
      return v?.status === "active" && JSON.stringify(v.members.map(m => m.key).sort()) === JSON.stringify(want) && want.includes(v.members.find(m => m.role === "admin")?.key ?? "");
    }), 5 * 60_000, 1000, what);
    // Their leaves are done: the commit removing them came back, and the tombstone went (one the role went on from
    // stays a while after, for the leaves that followed the role to it).
    await world.until(() => gone.every(p => !stored(p, id)), 5 * 60_000, 1000, what);
    const admins = stay.filter(p => world.view(p, id)!.isAdmin);
    expect(admins.length, what()).toBe(1);
    const admin = admins[0], other = stay.find(p => p !== admin)!;
    // The admin can do what only an admin does: rename, hand out a link, remove.
    await admin.groups.rename(id, "Still here");
    expect(await admin.groups.enableLink(id)).toBeTruthy();
    await admin.groups.remove(id, key(other));
    const left = stay.filter(p => p !== other);
    await world.until(() => left.every(p => world.view(p, id)?.name === "Still here" && world.view(p, id)!.members.length === left.length), 2 * 60_000, 1000, what);
  }

  const five = ["alice", "bob", "carol", "dave", "erin"];
  for (const seed of [11, 22, 33]) {
    it(`seed ${seed}: the admin leaves and the member its app picked leaves at the same moment`, async () => {
      const { world, id, peers, alice, key, peerOf } = await group(seed);
      const next = peerOf(alice.groups.successor(id)!);
      await Promise.allSettled([alice.groups.leave(id), next.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== alice && p !== next), [alice, next], key);
    });

    it(`seed ${seed}: the admin makes a member the admin while that member leaves`, async () => {
      const { world, id, peers, alice, key } = await group(seed);
      const bob = peers[1];
      await Promise.allSettled([alice.groups.makeAdmin(id, key(bob)), bob.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== bob), [bob], key);
    });

    it(`seed ${seed}: control, the member leaves a second after the role reached it`, async () => {
      const { world, id, peers, alice, key } = await group(seed);
      const bob = peers[1];
      await alice.groups.makeAdmin(id, key(bob));
      await world.run(1_000);
      await bob.groups.leave(id);
      await converged(world, id, peers.filter(p => p !== bob), [bob], key);
    });
  }

  /*
   * More leaves while the role moves: a leave that followed the role to a leaver was lost with that leaver's tombstone,
   * which kept no edge to it, and its member stayed in the roster for good. On relay links too, where the edge to the
   * leaver the role went on from comes up after the commit that removed it (seed 44: through two such leavers).
   */
  const races: [number, NetworkModel | null][] = [[11, null], [22, null], [33, null], [11, RELAY_NETWORK], [44, RELAY_NETWORK]];
  for (const [seed, network] of races) {
    const on = network ? " on relay links" : "";
    it(`seed ${seed}${on}: the admin, the member its app picked and a third member leave at the same moment`, async () => {
      const { world, id, peers, alice, key, peerOf } = await group(seed, five, network);
      const next = peerOf(alice.groups.successor(id)!), third = peers.find(p => p !== alice && p !== next)!;
      await Promise.allSettled([alice.groups.leave(id), next.groups.leave(id), third.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== alice && p !== next && p !== third), [alice, next, third], key);
    });

    it(`seed ${seed}${on}: the admin makes a member the admin while that member and another leave`, async () => {
      const { world, id, peers, alice, key } = await group(seed, five, network);
      const [, bob, carol] = peers;
      await Promise.allSettled([alice.groups.makeAdmin(id, key(bob)), bob.groups.leave(id), carol.groups.leave(id)]);
      await converged(world, id, peers.filter(p => p !== bob && p !== carol), [bob, carol], key);
    });
  }
});
