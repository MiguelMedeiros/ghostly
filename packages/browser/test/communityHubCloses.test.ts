import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A hub that carries many members closes its app. They wait the hub's 20 s, then all ask the hub left in the same
 * second: its lobby keeps 6 requests, so the later writes push out the earlier. A member pushed out of a full lobby
 * waited for its 20 s refresh, while the lobby held requests the hub had already taken: CLI daemons were cut off for up
 * to 115 s (2026-10-19). On CLI daemons, as there: their reads go to the DHT, not the relays' budget (`unmetered`).
 */
describe("a hub that carries many members closes its app", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("they are all on the hub left soon after the hub's wait, though its lobby keeps only 6 requests", async () => {
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
    // The admin's app closes for a while: its members go to another hub, and stay there once it is back.
    world.redialSeen = true;
    admin.online = false;
    await world.run(60_000);
    admin.online = true;
    await world.run(90_000);
    const hubs = peers.filter(p => p.groups.communities.isHub(id));
    const carried = (h: Peer) => rest.filter(p => p !== h && !p.groups.communities.isHub(id) && edgesUp(p).length > 0 && edgesUp(p).every(k => k === keyOf(h)));
    const hub = hubs.filter(h => h !== admin).sort((a, b) => carried(b).length - carried(a).length)[0];
    expect(hub, `hubs: ${hubs.map(h => h.name)}`).toBeDefined();
    const cutOff = carried(hub);
    // More than the lobby's 6 places.
    expect(cutOff.length).toBeGreaterThan(6);

    hub.online = false;
    const closedAt = world.now, back = new Map<string, number>();
    await world.until(() => {
      for (const p of cutOff) if (!back.has(p.name) && edgesUp(p).some(k => k !== keyOf(hub))) back.set(p.name, world.now - closedAt);
      return cutOff.every(p => back.has(p.name));
    }, 3 * 60_000);
    // 20 s waiting for the hub, a lobby reading (every 6 s) or two, and the edge: 6 at 28 s, 6 at 33 s. Before, the 6
    // pushed out of the lobby were back at 46 s.
    expect(Math.max(...back.values())).toBeLessThanOrEqual(35_000);
    const left = rest.filter(p => p !== hub);
    await left[0].groups.send(id, "still here?");
    expect(await world.until(() => left.every(p => world.texts(p, id).includes("still here?")), 60_000)).toBeLessThanOrEqual(5_000);
  });
});
