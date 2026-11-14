import { describe, expect, it } from "vitest";
import type { GroupView } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs

/**
 * A private group's "Hub" badges (`members[].hub`, `hubs.hub`) as the app shows them: the node builds a group's view
 * again only for a state that names the group (`emit(undefined, groupId)`) or none. A beacon reading that adds a hub,
 * and a hub that ages out of the beacon, ask for that state themselves: nothing else may happen in the group.
 */

/** What a member's badges show: whether it is a hub, and the members marked as hubs. */
const badges = (v: GroupView | undefined) => JSON.stringify({ hub: v?.hubs?.hub, hubs: v?.members.filter(m => m.hub).map(m => m.key).sort() });

describe("a private group's Hub badges", () => {
  it("follow a hub coming and a hub aging out of the beacon, with no other change in the group", async () => {
    const world = new CommunityWorld();
    // Each peer's views as the last state it pushed had them: built again when a state names the group, or none.
    const pushed = new Map<Peer, string>(), asked = new Set<Peer>();
    let id = "";
    const hooks = (p: Peer) => ({ emit: (_delay?: number, groupId?: string) => { if (groupId === undefined || groupId === id) asked.add(p); } });
    const view = (p: Peer) => world.view(p, id);
    /** A second of the world, then the states it asked for, built (the node's own is due 50 ms later). */
    const second = async () => {
      await world.run(1_000);
      for (const p of asked) pushed.set(p, badges(view(p)));
      asked.clear();
    };
    const hubs = [2, 5];
    const admin = world.add("admin", hooks);
    id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers = [admin];
    for (let i = 1; i < 20; i++) {
      const p = world.add(`p${i}`, hooks, { staysOnline: hubs.includes(i) });
      await p.groups.joinByLink(link);
      for (let t = 0; t < 300 && view(p)?.status !== "active"; t++) await second();
      peers.push(p);
    }
    const stale = (ps: Peer[]) => ps.filter(p => pushed.get(p) !== badges(view(p))).map(p => `${p.name}: shown ${pushed.get(p)}, now ${badges(view(p))}`);
    const marked = (p: Peer) => view(p)!.members.filter(m => m.hub).length;
    // Both hubs found by every member: each change of a badge pushed as it came.
    for (let t = 0; t < 600 && !peers.every(p => marked(p) === 2); t++) {
      await second();
      expect(stale(peers)).toEqual([]);
    }
    expect(peers.every(p => marked(p) === 2)).toBe(true);
    // One hub's app closes: it ages out of the beacon, and its badge goes on every member's screen.
    const gone = peers[hubs[1]], rest = peers.filter(p => p !== gone);
    gone.online = false;
    for (let t = 0; t < 900 && !rest.every(p => marked(p) === 1); t++) {
      await second();
      expect(stale(rest)).toEqual([]);
    }
    expect(rest.every(p => marked(p) === 1)).toBe(true);
  }, 300_000);
});
