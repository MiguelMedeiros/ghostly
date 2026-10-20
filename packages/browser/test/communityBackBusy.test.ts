import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A member's app back while its relays' budget has nothing for background requests (bug hunt, 2026-10-13): the web app
 * opened with 30 chats whose contacts were online. Their signaling and the looks of its other chats took every request
 * each minute freed; a community's looks are background requests, and its reads of the beacon, which say who the hubs
 * are, never went out in 3 minutes. The edges of the last run were dropped at 60 s, no request reached a hub's lobby,
 * and none of its 5 communities came back, neither what was written while it was closed nor new lines 5 minutes later.
 */
async function community(world: CommunityWorld, admin: Peer, peers: Peer[]): Promise<string> {
  const id = await admin.groups.create("Back busy");
  const link = await admin.groups.enableLink(id);
  for (const p of peers) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
  await world.until(() => peers.every(p => world.member(p, id)), 10 * 60_000);
  return id;
}

describe("a community member back while its background requests are held", { timeout: 120_000 }, () => {
  it("finds its hub and gets what was written while it was away", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const id = await community(world, alice, [bob, carol]);
    await world.run(3 * 60_000);
    // Two hubs and a member (3 members, `minHubs` 2): the member goes away long enough for its hubs to drop its edge.
    const member = [alice, bob, carol].find(p => !p.groups.communities.isHub(id))!;
    const hub = [alice, bob, carol].find(p => p.groups.communities.isHub(id))!;
    member.online = false;
    await world.run(10 * 60_000);
    await hub.groups.send(id, "written while you were away");
    world.holdBackground = p => p === member;
    await world.restart(member);
    const took = await world.until(() => world.texts(member, id).includes("written while you were away"), 3 * 60_000, 1_000,
      () => `hub: ${member.groups.communities.isHub(id)}, edges up: ${[...member.links.values()].filter(e => e.kind === "edge" && e.upAt !== undefined).length}`);
    // (The hub reads its lobby every half minute when nobody asked there lately.)
    expect(took).toBeLessThanOrEqual(45_000);
    expect(member.groups.communities.isHub(id)).toBe(false);
  });
});
