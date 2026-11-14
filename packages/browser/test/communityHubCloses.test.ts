import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A hub that carries many members closes its app. They wait the hub's 20 s, then all asked the hub left in the same
 * second: its lobby keeps 6 requests, so the later writes pushed out the earlier. A member pushed out of a full lobby
 * waited for its 20 s refresh, while the lobby held requests the hub had already taken: CLI daemons were cut off for up
 * to 115 s (2026-10-19). With only one hub left, a few of them step in for the hub that closed now (one for every 8 it
 * carried), and the others share the hubs. On CLI daemons, as there: their reads go to the DHT, not the relays' budget
 * (`unmetered`), so the hub left could take them all as fast; stepping in must not cost them more than it did.
 */
describe("a hub that carries many members closes its app", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("they are all on a hub soon after the hub's wait, the hub left and the members stepping in sharing them", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(1));
    restore = sameRun(world, 1);
    world.heldReads = true;
    const peers = Array.from({ length: 14 }, (_, i) => world.add(i ? `m${String(i).padStart(2, "0")}` : "admin", undefined, { unmetered: true }));
    const [admin, ...rest] = peers;
    const id = await admin.groups.create("Town");
    const link = await admin.groups.enableLink(id);
    for (const p of rest) {
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 5 * 60_000);
    }
    await world.run(60_000);
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgesUp = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => e.peer);
    const isHub = (p: Peer) => p.online && p.groups.communities.isHub(id);
    const hubs = peers.filter(isHub);
    expect(hubs.length, "two hubs: the admin's and one member's").toBe(2);
    const cutOff = rest.filter(p => !isHub(p) && edgesUp(p).length > 0 && edgesUp(p).every(k => k === keyOf(admin)));
    // More than the lobby's 6 places.
    expect(cutOff.length).toBeGreaterThan(6);

    world.redialSeen = true;
    admin.online = false;
    const closedAt = world.now, back = new Map<string, number>();
    await world.until(() => {
      for (const p of cutOff) if (!back.has(p.name) && edgesUp(p).some(k => k !== keyOf(admin))) back.set(p.name, world.now - closedAt);
      return cutOff.every(p => back.has(p.name));
    }, 3 * 60_000);
    // 20 s waiting for the hub, a few turns, lobby readings every 6 s, and the edges: all back at 41 s. All of them asking
    // the hub left, they were back at 40 s; before its members re-asked a full lobby at once, at 46 s.
    expect(Math.max(...back.values())).toBeLessThanOrEqual(45_000);
    const stepped = rest.filter(p => !hubs.includes(p) && isHub(p));
    expect(stepped.length, "members that stepped in: one for every 8 the hub carried").toBeLessThanOrEqual(Math.ceil(cutOff.length / 8));
    for (const h of stepped) expect(rest.some(p => !isHub(p) && edgesUp(p).includes(keyOf(h))), `${h.name} stepped in and carries someone`).toBe(true);
    // From the hub left, through the edges between the hubs, which come up meanwhile (16 s).
    await rest[0].groups.send(id, "still here?");
    expect(await world.until(() => rest.every(p => world.texts(p, id).includes("still here?")), 60_000)).toBeLessThanOrEqual(20_000);
  });
});
