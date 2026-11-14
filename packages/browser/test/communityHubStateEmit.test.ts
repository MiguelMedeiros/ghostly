import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A community's view says whether this app relays for the others (`community.hub`, the header's "your app relays for
 * others"). The engine builds a group's view again only for a state that names it (or names none): a step up or down
 * as a hub that asked for no state left the header on the line before, in a quiet community, until something else
 * happened in it.
 */
describe("a community's hub line", { timeout: 120_000 }, () => {
  it("is asked for in a state each time this app steps up or down as a hub", async () => {
    const world = new CommunityWorld();
    // What a state asked for now would show of each group, and whether one was asked for in this step.
    const asked = new Map<Peer, boolean>();
    const add = (name: string) => {
      const peer: Peer = world.add(name, p => ({ emit: (_delay?: number, groupId?: string) => { if (groupId === undefined || groupId === id) asked.set(p, true); } }));
      return peer;
    };
    let id = "";
    const admin = add("admin"), bob = add("bob"), carol = add("carol");
    id = await admin.groups.create("Plaza");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }

    const shown = (p: Peer) => String(world.view(p, id)?.community?.hub);
    const peers = [admin, bob, carol];
    const before = new Map(peers.map(p => [p, shown(p)]));
    const missed: string[] = [];
    let flips = 0;
    // Long enough for hubs to step up, go idle and step down (`idleHubMs`), with nobody writing.
    for (let s = 0; s < 15 * 60; s++) {
      for (const p of peers) asked.set(p, false);
      await world.run(1_000);
      for (const p of peers) {
        const now = shown(p);
        if (now === before.get(p)) continue;
        flips++;
        if (!asked.get(p)) missed.push(`${p.name} at ${s} s: ${before.get(p)} -> ${now}`);
        before.set(p, now);
      }
    }
    expect(flips, "hub changes seen").toBeGreaterThan(0);
    expect(missed).toEqual([]);
  });
});
