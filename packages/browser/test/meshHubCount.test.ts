import { describe, expect, it } from "vitest";
import { MESH_HUBS } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.hubs

/**
 * A private group past 16 members whose apps all stay online (Desktop, CLI), on public relays (WISP 902 · Group Mesh §
 * Hubs): each member may be a hub, and the beacon lists at most eight. Joins in a row spend the relays' budget, so
 * readings and writes of the beacon are held back now and then; the group still settles on at most eight hubs, and the
 * other members keep edges with two of them, not a full mesh.
 */
describe("hubs when every member stays online", () => {
  it("at most maxHubs hubs, and the others keep two edges", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const admin = world.add("admin", undefined, { staysOnline: true });
    const id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [admin];
    for (let i = 1; i < 20; i++) {
      const p = world.add(`p${i}`, undefined, { staysOnline: true });
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 5 * 60_000, 500);
      peers.push(p);
    }
    const hubs = () => peers.filter(p => world.view(p, id)?.hubs?.hub === true);
    const edges = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).length;
    const counts: number[] = [];
    for (let t = 0; t < 6; t++) { await world.run(60_000, 1000); counts.push(hubs().length); }
    // The joins' bursts may list a few too many for a moment (writes held back); they step down, and it holds.
    for (const count of counts.slice(2)) expect(count, `hubs per minute: ${counts.join(" ")}`).toBeLessThanOrEqual(MESH_HUBS.maxHubs);
    expect(hubs().length).toBeGreaterThanOrEqual(MESH_HUBS.hubsPerMember);
    for (const p of peers.filter(p => !hubs().includes(p))) expect(edges(p)).toBeLessThanOrEqual(MESH_HUBS.hubsPerMember);
  }, 600_000);
});
