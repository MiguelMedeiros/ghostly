import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs.budget, groups.protocol.community-topology

/**
 * A Mac's budget of connections in a community (WISP 903 · Group Community § Topology; 902 · Group Mesh § Hubs,
 * Budget): WKWebView opens only about 46 connections in one page, so the Desktop app on a Mac gives its groups 40
 * (`peerBudget`), shared with its other groups and its 1:1 chats. A community hub keeps no more edges than that leaves,
 * and says it is full when it is, so members and joiners go to another hub.
 */
describe("a community hub on a Mac keeps within its budget", { timeout: 300_000 }, () => {
  it("with more joiners than its room, the Mac hub stays within it and everyone still reaches the group", async () => {
    const world = new CommunityWorld();
    // Its other groups hold 30 of its 40 connections: 10 left for this one.
    const mac = world.add("mac", undefined, { peerBudget: 40, heldElsewhere: 30 });
    const room = 10;
    const id = await mac.groups.create("Open door");
    const link = await mac.groups.enableLink(id);
    const joiners = Array.from({ length: 16 }, (_, i) => world.add(`p${i}`));
    let most = 0;
    const held = () => { most = Math.max(most, mac.links.size); return mac.links.size; };
    for (const p of joiners) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => { held(); return joiners.every(p => world.member(p, id)); }, 20 * 60_000, 1000,
      () => `members: ${joiners.filter(p => world.member(p, id)).length}/${joiners.length}, mac holds ${mac.links.size}`);
    // Every member ends with an edge up to some hub, and the Mac never held more than its room.
    const everyone: Peer[] = [mac, ...joiners];
    const connected = (p: Peer) => (world.view(p, id)?.community?.connected ?? 0) > 0;
    await world.until(() => { held(); return everyone.every(connected); }, 10 * 60_000, 1000,
      () => everyone.filter(p => !connected(p)).map(p => p.name).join(","));
    for (let t = 0; t < 60; t++) { await world.run(1000); held(); }
    expect(most).toBeLessThanOrEqual(room);
    expect(mac.groups.communities.isHub(id)).toBe(true);
    for (const p of everyone) await p.groups.send(id, `hi from ${p.name}`);
    await world.run(15_000);
    held();
    for (const p of everyone) expect(new Set(world.texts(p, id)).size, p.name).toBe(everyone.length);
    expect(most).toBeLessThanOrEqual(room);
  });
});
