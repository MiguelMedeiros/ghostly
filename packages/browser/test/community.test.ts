import { describe, expect, it } from "vitest";
import { COMMUNITY_TOPOLOGY, decodeCommunityLink } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join, groups.community.send, groups.community.catch-up, groups.community.remove, groups.community.leave, groups.protocol.community-topology

/**
 * The community engine (`packages/browser/src/engine/community.ts`) on headless peers: admission
 * through the link by whichever member is there, hubs elected through the beacon, relaying, catch-up
 * by members who are not the author, leaving, removal and restart.
 */
async function community(world: CommunityWorld, admin: Peer): Promise<{ id: string; link: string }> {
  const id = await admin.groups.create("Open door");
  const link = await admin.groups.enableLink(id);
  return { id, link };
}

async function joinAll(world: CommunityWorld, id: string, link: string, peers: Peer[]): Promise<void> {
  for (const p of peers) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
  await world.until(() => peers.every(p => world.member(p, id)), 10 * 60_000);
}

describe("community groups on headless engines", { timeout: 120_000 }, () => {
  it("joins through the link with the admin away: any member lets people in", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, alice);
    expect(link).toMatch(/^group2\//);
    expect(decodeCommunityLink(link)?.g).toBe(id);
    expect(alice.groups.views()[0]).toMatchObject({ profile: "community", isAdmin: true, entryLink: link });
    await joinAll(world, id, link, [bob]);
    // Every member sees the link, since every member can let people in.
    expect(world.view(bob, id)?.entryLink).toBe(link);
    alice.online = false;
    await joinAll(world, id, link, [carol]);
    expect(world.view(carol, id)?.members).toHaveLength(3);
    await world.run(15_000);
    await carol.groups.send(id, "carol, let in by bob");
    await bob.groups.send(id, "bob here");
    await world.run(5_000);
    expect(world.texts(bob, id)).toEqual(expect.arrayContaining(["carol, let in by bob", "bob here"]));
    expect(world.texts(carol, id)).toEqual(expect.arrayContaining(["carol, let in by bob", "bob here"]));
    // Alice returns and is caught up by whoever is there: Carol's message, not re-sent by Carol.
    carol.online = false;
    alice.online = true;
    await world.until(() => world.texts(alice, id).includes("carol, let in by bob"), 3 * 60_000);
    expect(world.view(alice, id)?.members).toHaveLength(3);
    // Names travel with the messages.
    expect(world.view(alice, id)?.members.find(m => m.nick === "carol")).toBeDefined();
  });

  it("elects hubs through the beacon; members keep edges with hubs only, and everyone reads everyone", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin");
    const { id, link } = await community(world, admin);
    const others = Array.from({ length: 9 }, (_, i) => world.add(`p${i}`));
    await joinAll(world, id, link, others);
    const everyone = [admin, ...others];
    await world.run(30_000);
    const hubs = everyone.filter(p => p.groups.communities.isHub(id));
    expect(hubs.length).toBeGreaterThanOrEqual(COMMUNITY_TOPOLOGY.minHubs);
    expect(hubs.length).toBeLessThanOrEqual(4);
    // A member's edges go to hubs, and at most two of them.
    for (const p of everyone.filter(p => !hubs.includes(p))) {
      const peersOf = [...p.links.values()].filter(e => e.kind === "edge").map(e => e.peer);
      expect(peersOf.length).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.hubsPerMember);
    }
    for (const p of everyone) await p.groups.send(id, `hi from ${p.name}`);
    await world.run(10_000);
    for (const p of everyone) expect(new Set(world.texts(p, id)).size).toBe(everyone.length);
    // A member hears it as a community with hubs.
    const member = everyone.find(p => !hubs.includes(p))!;
    expect(world.view(member, id)?.community).toMatchObject({ hub: false });
    expect(world.view(member, id)?.community?.connected).toBeGreaterThan(0);
  });

  it("the admin removes someone: gone from every roster, reads nothing after; a member's leave is committed by a hub", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol"), dave = world.add("dave");
    const { id, link } = await community(world, admin);
    await joinAll(world, id, link, [bob, carol, dave]);
    await world.run(20_000);
    const carolKey = world.view(carol, id)!.myKey!;
    await admin.groups.remove(id, carolKey);
    await world.until(() => world.view(carol, id)?.status === "removed", 60_000);
    await world.run(5_000);
    for (const p of [admin, bob, dave]) expect(world.view(p, id)?.members.map(m => m.key)).not.toContain(carolKey);
    await bob.groups.send(id, "after carol");
    await world.run(5_000);
    expect(world.texts(dave, id)).toContain("after carol");
    expect(world.texts(carol, id)).not.toContain("after carol");

    // Dave leaves: his list is empty at once; a hub commits it.
    const daveKey = world.view(dave, id)!.myKey!;
    await dave.groups.leave(id);
    expect(dave.groups.views()).toEqual([]);
    await world.until(() => !world.view(bob, id)?.members.some(m => m.key === daveKey), 2 * 60_000);
    expect(world.view(admin, id)?.members.map(m => m.key)).not.toContain(daveKey);
    await admin.groups.send(id, "after dave");
    await world.run(5_000);
    expect(world.texts(bob, id)).toContain("after dave");
  });

  it("a replaced link admits nobody; the new one works through any member", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), eve = world.add("eve"), finn = world.add("finn");
    const { id, link } = await community(world, admin);
    await joinAll(world, id, link, [bob]);
    await world.run(15_000);
    const fresh = await admin.groups.enableLink(id, true);
    expect(fresh).not.toBe(link);
    await world.until(() => world.view(bob, id)?.entryLink === fresh, 60_000);
    admin.online = false;
    await eve.groups.joinByLink(link);
    await world.run(60_000);
    expect(world.member(eve, id)).toBe(false);
    await joinAll(world, id, fresh, [finn]);
    expect(world.view(finn, id)?.members).toHaveLength(3);
  });

  it("an admin who leaves hands the role on; a restart keeps everything", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, admin);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(20_000);
    await admin.groups.leave(id);
    expect(admin.groups.views()).toEqual([]);
    await world.until(() => world.view(bob, id)?.members.length === 2 && world.view(carol, id)?.members.length === 2, 2 * 60_000);
    expect([world.view(bob, id)!.isAdmin, world.view(carol, id)!.isAdmin].filter(Boolean)).toHaveLength(1);
    await bob.groups.send(id, "before restart");
    await world.until(() => world.texts(carol, id).includes("before restart"), 2 * 60_000);
    // Carol restarts from her store: same roster, same history, and she talks.
    const again = world.add("carol-again");
    again.groups = new (bob.groups.constructor as typeof import("../src/engine/groups").Groups)((carol.groups as unknown as { host: import("../src/engine/groups").GroupsHost }).host, carol.store);
    await again.groups.load();
    expect(again.groups.views()[0]).toMatchObject({ id, profile: "community", status: "active" });
    expect((await again.groups.messages(id)).some(m => m.text === "before restart")).toBe(true);
  });

  it("a member whose fresh secret was lost on the way asks for it and gets it", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, admin);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(20_000);
    // Every sealed secret meant for Carol is lost, however it travels.
    world.drop = (_from, to, frame) => to === carol && (frame.t === "group-secret" || frame.t === "group-secrets");
    await admin.groups.rotate(id);
    await world.run(10_000);
    expect(world.view(carol, id)?.canSend).toBe(false);
    // The network heals: her app keeps asking until a sync brings it.
    world.drop = null;
    await world.until(() => !!world.view(carol, id)?.canSend, 2 * 60_000);
    await carol.groups.send(id, "carol has the new key");
    await world.until(() => world.texts(admin, id).includes("carol has the new key"), 60_000);
  });

  it("hubs cut off from each other admit on both sides; when they meet, the losers are let in again and everyone ends on one roster", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, admin);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(30_000);
    // Two halves, each with members that can let people in; newcomers arrive on both sides.
    const left = new Set([admin, bob]);
    const newcomers = Array.from({ length: 6 }, (_, i) => world.add(`n${i}`));
    newcomers.slice(0, 3).forEach(p => left.add(p));
    world.part = p => left.has(p) ? 0 : 1;
    // Pkarr is shared by both halves (it is the relays, not the members, that are cut off here).
    for (const p of newcomers) await p.groups.joinByLink(link);
    // The door may be on the other side: an attempt that cannot reach the joiner costs a turn, then the next hub tries.
    const everyone = [admin, bob, carol, ...newcomers];
    const nameOf = (k: string) => everyone.find(q => q.groups.communities.session(id)?.myKey === k)?.name ?? k.slice(0, 5);
    const state = () => everyone.map(p => { const v = world.view(p, id); return `${p.name}:${v?.status ?? "joining"}/e${v?.epoch}/m${v?.members.length}/${p.groups.communities.isHub(id) ? "H" : "-"}/edges=${[...p.links.values()].filter(e => e.kind === "edge").map(e => nameOf(e.peer)).join("+")}/entries=${[...p.links.values()].filter(e => e.kind !== "edge").map(e => e.kind + ":" + nameOf(e.peer)).join("+")}`; }).join("  ");
    await world.until(() => newcomers.every(p => world.member(p, id)), 30 * 60_000, 1000, state);
    world.part = null;
    await world.until(() => everyone.every(p => world.view(p, id)?.members.length === 9) && new Set(everyone.map(p => world.view(p, id)?.epoch)).size === 1, 15 * 60_000, 1000,
      state);
    for (const p of everyone) await p.groups.send(id, `${p.name} after the merge`);
    await world.until(() => everyone.every(p => new Set(world.texts(p, id).filter(t => t.endsWith("after the merge"))).size === everyone.length), 3 * 60_000);
  });
});
