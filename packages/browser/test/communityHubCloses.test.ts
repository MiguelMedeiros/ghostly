import { describe, expect, it } from "vitest";
import { lobbyKeys } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.leave, groups.protocol.community-topology

/**
 * agents#1718: a hub that carries many members closes its app. They wait the hub's 20 s, then all ask the hub left in
 * the same second: its lobby keeps 6 requests, so the later writes push out the earlier, and the hub's own reads of its
 * lobby, held back by its relay budget, answer the lobby it already knew. CLI daemons: 22-115 s cut off.
 */
async function settled(world: CommunityWorld, names: string[], settle = 60_000): Promise<{ id: string; peers: Peer[] }> {
  const peers = names.map(n => world.add(n));
  const [admin, ...rest] = peers;
  const id = await admin.groups.create("Town");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) {
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000);
  }
  await world.run(settle);
  return { id, peers };
}

const connected = (world: CommunityWorld, p: Peer, id: string) => world.view(p, id)?.community?.connected ?? 0;

describe("a hub that carries many members closes its app", { timeout: 300_000 }, () => {
  it("they are all on another hub soon after the hub's wait, though the hub left reads its lobby held back", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    world.heldReads = true;
    const names = Array.from({ length: 14 }, (_, i) => (i ? `m${String(i).padStart(2, "0")}` : "admin"));
    const { id, peers } = await settled(world, names);
    const [admin, ...rest] = peers;
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgesUp = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => e.peer);
    // Members stay on the hub they found first (the admin): its app closes for a while, so they go to the other hub,
    // and it comes back, as in the lab where M01 carried 6-10 of 20.
    world.redialSeen = true;
    admin.online = false;
    await world.run(60_000);
    admin.online = true;
    await world.run(90_000);
    const hubs = peers.filter(p => p.groups.communities.isHub(id));
    // The hub (not the admin) that carries the most members alone.
    const carried = (h: Peer) => rest.filter(p => p !== h && !p.groups.communities.isHub(id) && edgesUp(p).length > 0 && edgesUp(p).every(k => k === keyOf(h)));
    const hub = hubs.filter(h => h !== admin).sort((a, b) => carried(b).length - carried(a).length)[0];
    expect(hub, `hubs: ${hubs.map(h => h.name)}`).toBeDefined();
    const orphans = carried(hub);
    console.log(`HUB CLOSES: hubs ${hubs.map(h => `${h.name}(${carried(h).length})`).join(" ")}; ${hub.name} carries ${orphans.length}`);
    expect(orphans.length).toBeGreaterThanOrEqual(4);

    // The hubs left read their own lobby held back by the budget, as M00 did for ~40 s.
    const rv = rest[0].groups.communities.session(id)!.state.rv;
    const ownLobby = new Map(hubs.filter(h => h !== hub).map(h => [lobbyKeys(rv, id, keyOf(h)).identity.pubKeyZ32, h]));
    const closedAt = world.now;
    if (!process.env.NOHOLD) world.holdRead = (peer, key) => ownLobby.get(key) === peer && world.now - closedAt < 45_000;
    if (process.env.TRACE) world.onPkarr = (who, op, key, background, door) => {
      const lobbyOf = ownLobby.get(key);
      if (lobbyOf) console.log(`TRACE ${((world.now - closedAt) / 1000).toFixed(1)} ${who.name} ${op} lobby(${lobbyOf.name}) bg=${background} door=${door}`);
    };
    hub.online = false;
    const left = rest.filter(p => p !== hub);
    const back = new Map<string, number>();
    await world.until(() => {
      for (const p of orphans) if (!back.has(p.name) && edgesUp(p).some(k => k !== keyOf(hub))) back.set(p.name, world.now - closedAt);
      return orphans.every(p => back.has(p.name));
    }, 4 * 60_000);
    const times = [...back.values()].sort((a, b) => a - b);
    console.log(`HUB CLOSES: back after ${times.map(t => (t / 1000).toFixed(1)).join(", ")} s`);
    await left[0].groups.send(id, "still here?");
    const heard = await world.until(() => left.every(p => world.texts(p, id).includes("still here?")), 60_000);
    expect(heard).toBeLessThanOrEqual(5_000);
    // 20 s waiting for the hub, then a few seconds to ask, be read and signal.
    expect(Math.max(...times)).toBeLessThanOrEqual(35_000);
    expect(left.every(p => connected(world, p, id) > 0)).toBe(true);
  });
});
