import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.catch-up

/*
 * Past 16 members a private group runs on hubs and a member keeps edges with two of them only: a member that never
 * writes has no message to carry its name, so its name record does (WISP 902 § Messages, "The name record"). Here no
 * edge says a name at all, so every name a member shows came that way.
 */

describe("a member that never writes, in a private group on hubs", () => {
  it("shows by its name to every member, with no edge between them and no message from it", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin", undefined, {});
    const id = await admin.groups.create("Quiet", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [admin];
    for (let i = 1; i < 18; i++) {
      const p = world.add(`p${i}`, undefined, { staysOnline: i === 2 || i === 5 });
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 5 * 60_000, 500);
      peers.push(p);
    }
    const view = (p: Peer) => world.view(p, id)!;
    await world.until(() => peers.every(p => !!view(p).hubs && view(p).members.length === peers.length && view(p).members.every(m => m.online)), 10 * 60_000, 1000);
    // The edges that are not wanted close (the admin's with the last members it let in after two minutes).
    await world.run(150_000);
    expect(peers.every(p => world.texts(p, id).length === 0)).toBe(true);
    const keyOf = (p: Peer) => view(p).myKey!;
    const unnamed = (p: Peer) => view(p).members.filter(m => !m.me && m.nick !== peers.find(q => keyOf(q) === m.key)?.name);
    await world.until(() => peers.every(p => unnamed(p).length === 0), 5 * 60_000, 1000,
      () => peers.filter(p => unnamed(p).length).map(p => `${p.name}: ${unnamed(p).length}`).join(", "));
    // Most of them through no edge of their own.
    expect(view(peers[9]).members.filter(m => m.viaHub).length).toBeGreaterThan(10);
  }, 300_000);
});
