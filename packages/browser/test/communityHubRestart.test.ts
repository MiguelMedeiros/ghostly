import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.catch-up, groups.protocol.community-topology

/**
 * A daemon that is the hub of its 5 communities (their admin, as a bot that made them is) restarts while its 30 chats'
 * signaling and looks take every background request its relays' minute frees (bug hunt, 2026-10-14). Back, it steps up
 * as a hub at once, before any edge is up; its beacon entry (read, merged, written) and its lobby were background looks,
 * so its entry went unwritten, the other hubs took it for gone (`hubDead`), its members asked them, and it got back into
 * its communities one at a time, 4 to 10 minutes for five, one not at all in 16. A hub with no edge up asks its way back
 * as a member does (`Communities.wayBack`).
 *
 * Each run is the same (`sameRun`): under the relays' budget the 5 minutes before the restart are chaotic (which edge
 * gets a minute's requests first, a hub entry a second staler than another), and with random keys one run in three
 * went another way. In some of those the admin, idle beside two other hubs, stepped down before the restart, as an idle
 * hub does (line 31 failed); in others it came back as a member of a community whose hubs did not list it, and was
 * never back in that one (`wayBack`, the second test). Over 60 seeds, 54 hold this test's premise and pass, and the
 * other 6 are the admin stepping down before the restart.
 */
const COMMUNITIES = 5, MEMBERS = 6;

describe("the hub of its communities back from a restart while its background requests are held", { timeout: 120_000 }, () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("is back in each of them within a couple of minutes", async () => {
    const world = new CommunityWorld(undefined, null, seededRandom(1));
    restore = sameRun(world, 1);
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

  /**
   * Back from a restart as a member, with its background requests held: its first reading of the beacon is its way back,
   * the rest are background looks. Its edges stay down (the relays' budget, while its other links signal) and the relays
   * refuse its reads a while: its one reading ages out, every hub it listed looks stale, and it steps up as a hub, alone
   * as far as it knows. Alone, its readings and its entry were background looks, held: it never read the beacon again, no
   * hub listed it or opened an edge to it, and it was never back (bug hunt, 2026-10-17: one community in 10 minutes, the
   * first test's last but one line). A reading that aged out does not say it is alone (`Communities.wayBack`).
   */
  it("asks its way back once its one reading of the beacon aged out, though that reading left it alone", async () => {
    const world = new CommunityWorld(undefined, null, seededRandom(2));
    restore = sameRun(world, 2);
    const admin = world.add("admin");
    const id = await admin.groups.create("Community");
    const link = await admin.groups.enableLink(id);
    const peers = Array.from({ length: 4 }, (_, i) => world.add(`m${i}`));
    for (const p of peers) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => peers.every(p => world.member(p, id)), 10 * 60_000);
    await world.run(2 * 60_000);
    const me = peers.find(p => !p.groups.communities.isHub(id))!;
    me.online = false;
    await world.run(2_000);
    world.holdBackground = p => p === me;
    world.holdEdge = (a, b) => a === me || b === me;
    await world.restart(me);
    await world.run(10_000);
    world.failRead = p => p === me;
    await world.run(110_000);
    expect(me.groups.communities.isHub(id)).toBe(true);
    // The relays answer it again, and its edges come up once they are opened.
    world.failRead = null;
    world.holdEdge = null;
    const start = world.now;
    let back: number | null = null;
    for (let n = 0; n < 24 && back === null; n++) {
      await admin.groups.send(id, `said once it is back ${n}`);
      await world.run(5_000);
      if (world.texts(me, id).some(t => t.startsWith("said once it is back"))) back = world.now - start;
    }
    // Before: not in 2 minutes (nor ever: alone, it read nothing more).
    expect(back !== null && back <= 30_000, String(back)).toBe(true);
  });
});
