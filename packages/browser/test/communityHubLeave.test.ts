import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.leave, groups.protocol.community-topology

/**
 * A hub that leaves the group (the admin, most often: the first hub) says so on its edges before it goes. Its members
 * hold that signed request: they go to another hub at once, rather than waiting for it as for an app that restarts,
 * and the hub that commits the leave looks at its lobby soon, since that hub's members are about to ask it.
 */
async function settled(world: CommunityWorld, names: string[]): Promise<{ id: string; peers: Peer[] }> {
  const peers = names.map(n => world.add(n));
  const [admin, ...rest] = peers;
  const id = await admin.groups.create("Town");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) {
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000);
  }
  await world.run(90_000);
  return { id, peers };
}

const connected = (world: CommunityWorld, p: Peer, id: string) => world.view(p, id)?.community?.connected ?? 0;

describe("a hub that leaves", { timeout: 120_000 }, () => {
  for (const network of [null, RELAY_NETWORK]) it(`its members are on another hub within seconds, and the group talks again (${network ? "relay budget" : "free network"})`, async () => {
    const world = new CommunityWorld(undefined, network);
    const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"]);
    const [admin, ...rest] = peers;
    expect(admin.groups.communities.isHub(id)).toBe(true);
    // The members only the admin carries: the ones the leave cuts off.
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).map(e => e.peer);
    const orphans = rest.filter(p => !p.groups.communities.isHub(id) && edgesOf(p).every(k => k === keyOf(admin)));
    expect(orphans.length).toBeGreaterThan(0);

    await admin.groups.leave(id);
    const speaker = orphans[0];
    await speaker.groups.send(id, "still here?");
    const back = await world.until(() => rest.every(p => connected(world, p, id) > 0), 3 * 60_000);
    const heard = await world.until(() => rest.every(p => world.texts(p, id).includes("still here?")), 3 * 60_000);
    // Waiting for the hub as for an app restarting took 20 s to a minute, and the next hub's idle lobby poll 30 s more.
    expect(back).toBeLessThanOrEqual(20_000);
    expect(heard).toBeLessThanOrEqual(5_000);
  });
});
