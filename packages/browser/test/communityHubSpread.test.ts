import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A hub carrying 13 of a community's 36 members is killed. Its members all pick another hub in the same second, and each
 * took the least loaded one: all 13 asked one hub, which opened their edges at once on its relays' budget and brought
 * none up for a minute and more, then they gave it up for the admin's, which did the same, and some stepped up as hubs
 * with nobody on them. Picked in proportion to each hub's room left (`pickHubs`), they split over the hubs left, each
 * takes a few, and they are back within the minute (bug hunt, 2026-11-11: 150-230 s, 7-8 hubs for 36 people).
 */
describe("a community of 36 whose hub carrying 13 is killed (relays' budget)", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("its members spread over the hubs left and every line reaches everyone within two minutes, with no new hub", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(1));
    restore = sameRun(world, 1);
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
    const hub = hubs.filter(h => h !== admin).sort((a, b) => upTo(b).length - upTo(a).length)[0];
    const carried = peers.filter(p => !isHub(p) && upTo(p).includes(hub));
    const onAdmin = peers.filter(p => !isHub(p) && !carried.includes(p));
    expect(carried.length, "the closing hub carries more than a lobby holds").toBeGreaterThan(6);

    hub.online = false;
    await world.run(22_000);
    await carried[0].groups.send(id, "from a cut-off member");
    await onAdmin[0].groups.send(id, "from the admin's side");
    const readers = everyone.filter(p => p !== hub);
    const missing = () => readers.flatMap(p => ["from a cut-off member", "from the admin's side"].filter(t => !world.texts(p, id).includes(t)).map(t => `${p.name}: ${t}`));
    const newHubs = new Set<Peer>();
    const took = await world.until(() => { for (const p of everyone) if (isHub(p) && !hubs.includes(p)) newHubs.add(p); return !missing().length; }, 10 * 60_000, 1000, () => missing().join(", "));
    // Before: 170 s, the 13 all asking one hub, and 3 members stepping up as hubs (seed 1).
    expect(took, `${carried.length} cut off`).toBeLessThanOrEqual(120_000);
    expect([...newHubs].map(p => p.name)).toEqual([]);
  });
});
