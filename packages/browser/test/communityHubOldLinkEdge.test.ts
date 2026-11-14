import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.join, groups.protocol.community-topology

/**
 * The admin replaced a community's link while a member hub's app was off the network (still open). Someone holding the
 * old link knocked, and the hub, back online, let them in before it heard the new link: on a branch that lost. Nobody's
 * roster holds the key, but the hub kept it among its members, refreshed as long as the edge was up, and the edge to
 * it stayed up for hours. A key no commit names is no member of a hub: its edge closes.
 */
describe("a key let in on the old link by a hub that was away", { timeout: 600_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  async function race(seed: number) {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const names = ["alice", "bob", "carol", "dave", "erin", "fred", "gina", "hank", "ivan"];
    const peers = names.map(n => world.add(n));
    const [alice, ...rest] = peers;
    const id = await alice.groups.create("Old link");
    const link = await alice.groups.enableLink(id);
    for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === names.length), 3 * 60_000);
    await world.run(60_000);
    const hub = rest.find(p => p.groups.communities.isHub(id));
    if (!hub) return null;
    hub.online = false;
    await world.run(2 * 60_000);
    await alice.groups.enableLink(id, true);
    await world.run(5_000);
    const zed = world.add("zed");
    await zed.groups.joinByLink(link);
    await world.run(10_000);
    world.reopen(hub);
    try { await world.until(() => world.member(zed, id), 2 * 60_000); } catch { return null; }
    return { world, id, peers, hub, zed, key: world.view(zed, id)!.myKey! };
  }

  /** Members (every one but the key) whose edge to it is up. */
  const edgesTo = (world: CommunityWorld, peers: Peer[], id: string, key: string) =>
    peers.filter(p => { const linkId = p.host.edges(id).get(key); return !!linkId && p.host.linkReady(linkId, 2); }).map(p => p.name);

  it("no member keeps an edge to it once the hub heard the new link", async () => {
    let raced = 0;
    for (const seed of [100, 103]) {
      const r = await race(seed);
      if (!r) continue;
      raced++;
      const { world, id, peers, hub, key } = r;
      const alice = peers[0];
      await world.until(() => world.view(hub, id)?.entryLink === world.view(alice, id)?.entryLink, 5 * 60_000);
      expect(peers.every(p => !world.view(p, id)!.members.some(m => m.key === key))).toBe(true);
      await world.run(60_000);
      expect(edgesTo(world, peers, id, key), `seed ${seed}`).toEqual([]);
      await world.run(29 * 60_000);
      expect(edgesTo(world, peers, id, key), `seed ${seed}, 30 min`).toEqual([]);
      restore?.(); restore = null;
    }
    expect(raced).toBeGreaterThan(0);
  });
});
