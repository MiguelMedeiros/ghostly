import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A catch-up answer over settles the gaps it did not fill (`settleGaps`): the members view of that group counts them no
 * more, and nothing else changed. The tick asked for a state naming no group, and the engine walks every member of every
 * group again for one of those (`pushedState`): on a hub of a community where people talk, a dozen times a minute (bug
 * hunt, 2026-11-14: 66 of the admin's 73 such states over 150 messages at 8 members, none at all while it was quiet).
 */
describe("a community where people talk", { timeout: 120_000 }, () => {
  it("asks for states that name the group, never one for every group, once its members' names are known", async () => {
    const world = new CommunityWorld();
    let id = "", counting = false;
    const full = new Map<Peer, number>(), named = new Map<Peer, number>();
    const add = (name: string) => world.add(name, p => ({
      emit: (_delay?: number, groupId?: string) => {
        if (!counting) return;
        if (groupId === undefined) full.set(p, (full.get(p) ?? 0) + 1);
        else if (groupId === id) named.set(p, (named.get(p) ?? 0) + 1);
      },
    }));
    const peers = ["admin", "bob", "carol", "dave", "erin"].map(add);
    const [admin, ...others] = peers;
    id = await admin!.groups.create("Plaza");
    const link = await admin!.groups.enableLink(id);
    for (const p of others) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    // Everyone says something once: each name is learned (a members view change of its own), then things settle.
    for (const p of peers) await p.groups.send(id, `hi from ${p.name}`);
    await world.run(2 * 60_000);

    counting = true;
    for (let s = 0, sent = 0; s < 3 * 60; s++) {
      if (s % 2 === 0) await peers[sent++ % peers.length]!.groups.send(id, `message ${sent}`);
      await world.run(1_000);
    }
    expect(named.get(admin!) ?? 0, "states naming the group").toBeGreaterThan(0);
    expect(Object.fromEntries(peers.map(p => [p.name, full.get(p) ?? 0]))).toEqual(Object.fromEntries(peers.map(p => [p.name, 0])));
  });
});
