import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs

/*
 * A member's name record after a start from older state (WISP 06 § Raised counters, WISP 902 § The name record). The
 * copy holds the record from before a rename the lost device made; every other member holds the newer one and refuses
 * the older. The copy signs its own record again once, above anything the lost device said, so the members with no
 * edge to it (most of them past 16 members) show the name it shares now.
 */

describe("a private group on hubs, after a member starts from older state", () => {
  it("shows the copy's name to every member, not the lost device's newer one, and the name tags match again", async () => {
    const world = new CommunityWorld();
    // The floor every raise moves up (`counterFloor`), per peer: 0 until a copy of p7 starts from a backup.
    const floors = new Map<string, number>();
    const add = (name: string, staysOnline = false) => world.add(name, (peer) => ({ seqFloor: () => floors.get(peer.name) ?? 0 }), { staysOnline });
    const admin = add("admin");
    const id = await admin.groups.create("Quiet", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [admin];
    for (let i = 1; i < 18; i++) {
      const p = add(`p${i}`, i === 2 || i === 5);
      await p.groups.joinByLink(link);
      await world.until(() => world.member(p, id), 5 * 60_000, 500);
      peers.push(p);
    }
    const view = (p: Peer) => world.view(p, id)!;
    await world.until(() => peers.every(p => !!view(p).hubs && view(p).members.length === peers.length && view(p).members.every(m => m.online)), 10 * 60_000, 1000);
    await world.run(120_000);

    const p7 = peers[7], others = peers.filter(p => p !== p7);
    const key = view(p7).myKey;
    const shown = () => [...new Set(others.map(p => view(p).members.find(m => m.key === key)?.nick))];
    // The backup: p7's groups before it renames.
    await p7.groups.flush();
    const backup = await p7.store.getGroups();
    p7.nick = "Seven";
    await world.restart(p7);
    await world.until(() => shown().length === 1 && shown()[0] === "Seven", 5 * 60_000, 1000);
    await world.run(60_000);

    // The backup is restored: its groups and its shared name go back, and the restore raises the floor.
    await p7.groups.flush();
    for (const g of backup) await p7.store.putGroup(g);
    p7.nick = "p7";
    floors.set("p7", 1 << 26);
    await world.restart(p7);
    await world.run(120_000);
    expect(shown()).toEqual(["p7"]);

    // Every member holds the same records again: a sync is not answered with all of them any more.
    let names = 0;
    world.drop = (_from, _to, frame) => { if (frame.t === "group-name") names++; return false; };
    await world.run(5 * 60_000);
    world.drop = null;
    expect(names).toBe(0);

    // Said once: another start under the same floor signs nothing new.
    const ownVersion = async () => { await p7.groups.flush(); return (await p7.store.getGroups()).find(g => g.id === id)?.names?.[key]?.v; };
    const signed = await ownVersion();
    await world.restart(p7);
    await world.run(60_000);
    expect(await ownVersion()).toBe(signed);
  }, 600_000);
});
