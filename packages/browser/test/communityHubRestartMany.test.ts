import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A community of 36 on two hubs, the admin's and a member's carrying 12. That member's app closes and starts again 20 s
 * later. Back, it dialled the edges to all 12 of its members at once, on its relays' 60 requests a minute, at 8-10 each
 * to come up: none came up in its first minute. Its members waited that minute for it, then one more on the admin's
 * hub, which then opened theirs all at once too, and 6 of them stepped up as hubs with nobody on them: 230 s until
 * everyone had everyone's lines again, 13 seeds in 19 (2026-11-13). It keeps 6 now, and the others ask the admin's hub
 * at once, so both bring the edges up side by side.
 */
describe("a community of 36 whose hub carrying 12 restarts (relays' budget)", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("brings a few of its members back, the others ask the other hub, and everyone hears everyone within 3 minutes", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(11));
    restore = sameRun(world, 11);
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
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id);
    const upTo = (p: Peer) => edgesOf(p).filter(e => e.upAt !== undefined).map(e => keyOf.get(e.peer));
    const isHub = (p: Peer) => p.online && p.groups.communities.isHub(id);
    const hubs = everyone.filter(isHub);
    expect(hubs.length, "two hubs: the admin's and one member's").toBe(2);
    const hub = hubs.find(h => h !== admin)!;
    const carried = peers.filter(p => !isHub(p) && upTo(p).includes(hub));
    expect(carried.length, "the hub carries more than it brings back at once").toBeGreaterThan(6);

    hub.online = false;
    await world.run(20_000);
    await world.restart(hub);
    await world.run(2_000);
    await carried[0].groups.send(id, "from a member of the hub that restarted");
    const onAdmin = peers.find(p => !isHub(p) && upTo(p).includes(admin))!;
    await onAdmin.groups.send(id, "from a member of the admin's hub");
    const missing = () => everyone.filter(p => !["from a member of the hub that restarted", "from a member of the admin's hub"].every(t => world.texts(p, id).includes(t))).map(p => p.name);
    // Before, nobody had both lines 3 minutes on (230 s): the 12 edges came up only after 6 of them had stepped up.
    await world.until(() => !missing().length, 3 * 60_000, 1000, () => `still missing a line: ${missing().join(", ")}`);
    expect(everyone.filter(p => !hubs.includes(p) && isHub(p)).length, "members that stepped up as hubs (6 before)").toBeLessThanOrEqual(3);
  });
});
