import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A daemon that is the hub of its 5 communities (their admin, as a bot that made them is) restarts while its 30 chats'
 * signaling and looks take every background request its relays' minute frees (bug hunt, 2026-10-14). Back, it steps up
 * as a hub at once, before any edge is up; its beacon entry (read, merged, written) and its lobby were background looks,
 * so its entry went unwritten, the other hubs took it for gone (`hubDead`), its members asked them, and it got back into
 * its communities one at a time, 4 to 10 minutes for five, one not at all in 16. A hub with no edge up asks its way back
 * as a member does (`Communities.wayBack`).
 */
const COMMUNITIES = 5, MEMBERS = 6;

describe("the hub of its communities back from a restart while its background requests are held", { timeout: 120_000 }, () => {
  it("is back in each of them within a couple of minutes", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin");
    const ids: string[] = [], members: Peer[][] = [];
    for (let c = 0; c < COMMUNITIES; c++) {
      const id = await admin.groups.create(`Community ${c}`);
      const link = await admin.groups.enableLink(id);
      const peers = Array.from({ length: MEMBERS }, (_, i) => world.add(`m${c}-${i}`));
      for (const p of peers) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
      await world.until(() => peers.every(p => world.member(p, id)), 10 * 60_000);
      ids.push(id); members.push(peers);
    }
    // The relays' budget from here on: edges signal and look at a link's pace.
    (world as unknown as { network: typeof RELAY_NETWORK }).network = RELAY_NETWORK;
    await world.run(5 * 60_000);
    expect(ids.every(id => admin.groups.communities.isHub(id))).toBe(true);
    admin.online = false;
    await world.run(2_000);
    world.holdBackground = p => p === admin;
    await world.restart(admin);
    // A group text every 5 s in each community, from a different member each time.
    const start = world.now, back: (number | null)[] = ids.map(() => null);
    for (let n = 0; n < 120 && back.includes(null); n++) {
      for (let c = 0; c < COMMUNITIES; c++) await members[c][n % MEMBERS].groups.send(ids[c], `said while the hub is back ${n}`);
      await world.run(5_000);
      ids.forEach((id, c) => { if (back[c] === null && world.texts(admin, id).some(t => t.startsWith("said while the hub is back"))) back[c] = world.now - start; });
    }
    // Before: none of the 5 in 10 minutes. (In this model an edge that nobody expects looks every half minute, and the
    // way back counts within the minute: its own allowance on the relays is not modelled.)
    expect(back.every(at => at !== null && at <= 2 * 60_000), JSON.stringify(back)).toBe(true);
    expect(ids.every(id => admin.groups.communities.isHub(id))).toBe(true);
  });
});
