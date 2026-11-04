import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A member that is one of a community's two hubs (the second hub a community of three elects) closes its app for 40 s and
 * opens it again, as a phone does. Back, it asks the admin's lobby for an edge as a member does, then steps up as a hub
 * again, and its request stays in the admin's lobby for two minutes. The beacon still listed it, so on each tick the
 * admin's app took it out of its members (a listed hub is no member of mine), and with its hub edge dropped long enough
 * to count as dead the edge it had just opened for it was not wanted, and closed. The lobby read three seconds later
 * opened it again: an edge that lived one second at a time never came up, and the member got what was said meanwhile
 * only through the other member, if that one's edge did not do the same (bug hunt, 2026-11-02: a web phone that was a hub
 * and two CLI daemons on a local relay, the admin's daemon started its edge to the phone up to 10 times in a minute and
 * each answer dropped a second later; back in 3 to 36 s, once not in 3 minutes).
 */
describe("a hub back after 40 s away", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("gets its edge to the admin in one go, and what the admin said while it was away", async () => {
    const world = new CommunityWorld(undefined, null, seededRandom(3));
    restore = sameRun(world, 3);
    const admin = world.add("admin");
    const id = await admin.groups.create("Three");
    const link = await admin.groups.enableLink(id);
    const peers = [world.add("phone"), world.add("bob")];
    for (const p of peers) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => peers.every(p => world.member(p, id)), 5 * 60_000);
    (world as unknown as { network: typeof RELAY_NETWORK }).network = RELAY_NETWORK;
    await world.run(2 * 60_000);
    const hub = peers.find(p => p.groups.communities.isHub(id));
    expect(hub, "one member is the second hub").toBeDefined();
    const key = world.view(hub!, id)!.members.find(m => m.me)!.key;
    const adminKey = world.view(admin, id)!.members.find(m => m.me)!.key;
    // The edges the admin's app opens toward the hub.
    let opened = 0;
    const open = admin.host.openEdge;
    admin.host.openEdge = async (state, other, expect) => { const before = [...admin.links.keys()].length; const linkId = await open(state, other, expect); if (other === key && admin.links.size > before) opened++; return linkId; };

    const took: number[] = [], opens: number[] = [];
    for (let round = 0; round < 3; round++) {
      hub!.online = false;
      await world.run(2_000);
      await admin.groups.send(id, `while away ${round}`);
      await world.run(38_000);
      opened = 0;
      hub!.online = true;
      await world.restart(hub!);
      // Back with no edge up, it asks the admin's lobby first, as a member asks its way back (`wayBack`): the web app did
      // in a second, before its next reading of the beacon made it a hub again.
      const communities = hub!.groups.communities as unknown as { live: Map<string, unknown>; askHub(g: string, live: unknown, hub: string, now: number): Promise<void> };
      await communities.askHub(id, communities.live.get(id), adminKey, world.now);
      took.push(await world.until(() => world.texts(hub!, id).includes(`while away ${round}`), 5 * 60_000));
      opens.push(opened);
      await world.run(30_000);
    }
    // One edge a return, kept until it is up. Before: opened again and closed at the next tick, 7 times in the three
    // returns here (in this model a lobby is read less often than the 3 s a hub reads its own after a member left).
    expect(opens.reduce((a, b) => a + b, 0), JSON.stringify({ took, opens })).toBeLessThanOrEqual(3);
  });
});
