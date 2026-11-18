import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A community of 36 on two hubs, the admin's and a member's carrying 19. That member's app is killed: it never comes
 * back. Its members all asked the admin's hub, which opened their 19 edges at once on its relays' 60 requests a minute
 * and brought almost none up for two minutes; they gave it up after a minute each, and 7 stepped up in the same second
 * as hubs with no edge to anyone: 232 s until everyone had everyone's lines (2026-11-13). Now a few of them step in for
 * the hub they lost, one for every 8 it carried, in turns by rank for its key, and the others ask them.
 */
describe("a community of 36 whose hub carrying 19 is killed, the admin's hub the only one left (relays' budget)", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("a few of its members step in for it, each carrying some, and everyone hears everyone within 150 s", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(17));
    restore = sameRun(world, 17);
    const admin = world.add("admin");
    const id = await admin.groups.create("Town");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [];
    for (let i = 1; i < 36; i += 12) {
      const wave = Array.from({ length: Math.min(12, 36 - i) }, (_, k) => world.add(`p${i + k}`));
      for (const p of wave) await p.groups.joinByLink(link);
      peers.push(...wave);
      await world.until(() => wave.every((p) => world.member(p, id)), 20 * 60_000);
    }
    await world.run(2 * 60_000);
    const everyone = [admin, ...peers];
    const keyOf = new Map(everyone.map(p => [world.view(p, id)!.members.find(m => m.me)!.key, p]));
    const upTo = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => keyOf.get(e.peer));
    const isHub = (p: Peer) => p.online && p.groups.communities.isHub(id);
    const hubs = everyone.filter(isHub);
    expect(hubs.length, "two hubs: the admin's and one member's").toBe(2);
    const hub = hubs.find(h => h !== admin)!;
    const carried = peers.filter(p => !isHub(p) && upTo(p).includes(hub));
    expect(carried.length, "the hub carries more than the admin's brings up in a minute").toBeGreaterThan(16);

    hub.online = false;
    await carried[0].groups.send(id, "from a member of the hub that was killed");
    const onAdmin = peers.find(p => !isHub(p) && upTo(p).includes(admin))!;
    await onAdmin.groups.send(id, "from a member of the admin's hub");
    const left = everyone.filter(p => p !== hub);
    const missing = () => left.filter(p => !["from a member of the hub that was killed", "from a member of the admin's hub"].every(t => world.texts(p, id).includes(t))).map(p => p.name);
    // Before, 232 s, and 7 members stepped up as hubs, with nobody on them at first.
    await world.until(() => !missing().length, 150_000, 1000, () => `still missing a line: ${missing().join(", ")}`);
    const stepped = left.filter(p => !hubs.includes(p) && isHub(p));
    expect(stepped.length, "members that stepped in: one for every 8 the hub carried").toBeLessThanOrEqual(3);
    for (const h of stepped) expect(left.some(p => !isHub(p) && upTo(p).includes(h)), `${h.name} stepped in and carries someone`).toBe(true);
  });
});
