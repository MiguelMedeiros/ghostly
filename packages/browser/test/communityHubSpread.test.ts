import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_TOPOLOGY } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A hub carrying 13 of a community's 36 members is killed. Its members all pick another hub in the same second, and each
 * took the least loaded one: all 13 asked one hub, which opened their edges at once on its relays' budget and brought
 * none up for a minute and more, then they gave it up for the admin's, which did the same, and some stepped up as hubs
 * with nobody on them (bug hunt, 2026-11-11: 150-230 s, 7-8 hubs for 36 people). Picked in proportion to each hub's
 * room left (`pickHubs`), they split over the hubs left. How soon they are all back depends on more than the pick (a
 * hub left with room, the relays' budget), so this checks the split, which the pick alone decides.
 */
describe("a community of 36 whose hub carrying 13 is killed (relays' budget)", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("its members ask the hubs left in proportion to the room each has, not all the least loaded one", async () => {
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
    expect(carried.length, "the closing hub carries more than a lobby holds").toBeGreaterThan(6);
    expect(hubs.length, "two hubs are left to spread over").toBeGreaterThanOrEqual(3);
    const hubKey = [...keyOf].find(([, p]) => p === hub)![0];

    // The hub each cut-off member asks first once it gives the closed one up, and the loads the beacon said then.
    type Live = { myHubs: string[]; beacon: { key: string; load: number }[] };
    const live = (p: Peer) => (p.groups.communities as unknown as { live: Map<string, Live> }).live.get(id);
    const asked = new Map<Peer, string>();
    let loads: Map<string, number> | undefined;
    hub.online = false;
    await world.until(() => {
      for (const p of carried) {
        const next = live(p)?.myHubs.find(key => key !== hubKey);
        if (asked.has(p) || !next) continue;
        asked.set(p, next);
        loads ??= new Map(live(p)!.beacon.filter(h => h.key !== hubKey).map(h => [h.key, h.load]));
      }
      return asked.size === carried.length;
    }, 2 * 60_000, 1000, () => `${asked.size} of ${carried.length} asked another hub`);
    // In proportion to the room each hub had left, as a draw is (each member's pick is a hash): its share, give or take
    // 2.5 standard deviations (13 members, rooms 31 and 39: up to 10 on the first). Before, all of them asked the least
    // loaded one.
    const room = (key: string) => COMMUNITY_TOPOLOGY.hubCapacity - (loads!.get(key) ?? 0);
    const total = [...loads!.keys()].reduce((sum, key) => sum + room(key), 0);
    const per = new Map<string, number>();
    for (const key of asked.values()) per.set(key, (per.get(key) ?? 0) + 1);
    const said = [...per].map(([key, n]) => `${keyOf.get(key)?.name}: ${n} (room ${room(key)})`).join(", ");
    expect(per.size, said).toBeGreaterThanOrEqual(2);
    const n = carried.length;
    for (const [key, got] of per) { const p = room(key) / total; expect(got, said).toBeLessThanOrEqual(Math.ceil(n * p + 2.5 * Math.sqrt(n * p * (1 - p)))); }
  });
});
