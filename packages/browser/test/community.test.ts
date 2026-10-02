import { describe, expect, it, vi } from "vitest";
import { COMMUNITY_TOPOLOGY, beaconKeys, decodeCommunityLink, freshHubs, readBeacon } from "@ghostly/core";
import { COMMUNITY_TIMINGS } from "../src/engine/community";
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
    // Whatever Carol still sends on an edge is dropped before the session sees it; a member's is not.
    const session = (bob.groups.communities as unknown as { live: Map<string, { session: { handle: (from: string, frame: unknown) => Promise<boolean> } }> }).live.get(id)!.session;
    const handle = vi.spyOn(session, "handle");
    const sync = { t: "group-sync", v: 2, g: id, e: 0, h: "0".repeat(64), have: {}, secrets: [] };
    await bob.groups.handleEdgeFrame(id, carolKey, sync);
    expect(handle).not.toHaveBeenCalled();
    await bob.groups.handleEdgeFrame(id, world.view(dave, id)!.myKey!, sync);
    expect(handle).toHaveBeenCalledTimes(1);
    handle.mockRestore();

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

  it("a hub's app restarts: its member keeps their edge, the hub keeps its own while they come up, and what was said meanwhile arrives over it", async () => {
    // A hub steps up after a random wait, as on a real app: its first seconds back, it is a member picking a hub.
    const world = new CommunityWorld({ ...COMMUNITY_TIMINGS, hubJitterMs: 3_000 }, null, () => 0.9);
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, alice);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(60_000);
    const everyone = [alice, bob, carol];
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgeTo = (p: Peer, to: Peer) => [...p.links].find(([, e]) => e.kind === "edge" && e.peer === keyOf(to))?.[0];
    // Two hubs and a member of one of them (3 members, `minHubs` 2).
    const member = everyone.find(p => !p.groups.communities.isHub(id))!;
    const hub = everyone.find(p => p !== member && edgeTo(member, p))!;
    const other = everyone.find(p => p !== member && p !== hub)!;
    expect(hub.groups.communities.isHub(id)).toBe(true);
    // The links themselves, not only their ids (an edge opened again has the same id): closed is closed.
    const memberEdge = edgeTo(member, hub)!, hubEdge = edgeTo(hub, member)!;
    const memberSide = member.links.get(memberEdge), hubSide = hub.links.get(hubEdge);
    // The hub's app quits, and says so on its edges (its member's edge drops).
    hub.online = false;
    await world.run(3_000);
    // The member does not drop the hub for another at once, nor step up as a hub itself: the app is likely restarting,
    // and the member's edge stays open, looking for it. It used to be closed at once and the hub avoided 40 s.
    expect(member.links.get(memberEdge)).toBe(memberSide);
    expect(member.groups.communities.isHub(id)).toBe(false);
    await other.groups.send(id, "said while the hub restarts");
    await world.run(2_000);
    // Its app starts again, with none of its last run's memory; the member's side is a few polls away (cut until then).
    world.cut = (a, b) => (a === hub && b === member) || (a === member && b === hub);
    await world.restart(hub);
    await world.run(5_000);
    // Whatever the fresh topology picks first, the edge of the last run stays while it comes up.
    expect(hub.links.get(hubEdge)).toBe(hubSide);
    expect(member.links.get(memberEdge)).toBe(memberSide);
    world.cut = null;
    const back = await world.until(() => world.texts(hub, id).includes("said while the hub restarts"), 60_000);
    expect(back).toBeLessThanOrEqual(3_000);
    // The member, whose hub it is again, has it too (its next sync with the hub at the latest).
    await world.until(() => world.texts(member, id).includes("said while the hub restarts"), 35_000);
    expect(member.links.get(memberEdge)).toBe(memberSide);
  });

  it("an app that starts while its read of the beacon fails does not take the group for one without hubs", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, alice);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(90_000);
    const everyone = [alice, bob, carol];
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    // Two hubs and a member (3 members, `minHubs` 2).
    const member = everyone.find(p => !p.groups.communities.isHub(id))!, hubs = everyone.filter(p => p !== member);
    expect(hubs.every(p => p.groups.communities.isHub(id))).toBe(true);
    const keys = beaconKeys(member.groups.communities.session(id)!.state.rv, id);
    const listed = () => freshHubs(readBeacon(keys, world.pkarr.get(keys.identity.pubKeyZ32) ?? []), world.now).map(h => h.key).sort();
    expect(listed()).toEqual(hubs.map(keyOf).sort());
    // The member's app starts again and its reads of the beacon fail for a while: the relays' budget, spent by
    // everything that starts at once, or the network. A failed read was taken for an empty beacon: the app became a
    // hub at once, the door alone, answered the knocks the real door was answering, and published a beacon without the
    // other hubs.
    world.failRead = (p, key) => p === member && key === keys.identity.pubKeyZ32;
    await world.restart(member);
    const dave = world.add("dave");
    await dave.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    const knock = [...dave.links.values()].find(e => e.kind === "guest")!.me;
    let wasHub = false, answering = 0, erased = false, joined: number | undefined;
    for (let t = 0; t < 20_000; t += 500) {
      await world.run(500, 500);
      wasHub ||= member.groups.communities.isHub(id);
      answering = Math.max(answering, everyone.filter(p => [...p.links.values()].some(e => e.kind === "host" && e.peer === knock)).length);
      erased ||= !hubs.every(p => listed().includes(keyOf(p)));
      if (joined === undefined && world.member(dave, id)) joined = t;
    }
    expect(wasHub).toBe(false);
    // (One hub at most: in this world an admission nobody collides with is over within a step.)
    expect(answering).toBeLessThanOrEqual(1);
    expect(erased).toBe(false);
    expect(joined).toBeLessThanOrEqual(10_000);
    // The reads work again: it is a member of a group with two hubs, as before, and reads everyone.
    world.failRead = null;
    await world.run(30_000);
    expect(member.groups.communities.isHub(id)).toBe(false);
    await alice.groups.send(id, "after the restart");
    await world.until(() => world.texts(member, id).includes("after the restart"), 35_000);
  });

  it("a hub whose read of the beacon fails as it republishes does not erase the other hubs from it", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, alice);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(90_000);
    const everyone = [alice, bob, carol], keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const hubs = everyone.filter(p => p.groups.communities.isHub(id));
    expect(hubs).toHaveLength(2);
    const keys = beaconKeys(alice.groups.communities.session(id)!.state.rv, id);
    const listed = () => freshHubs(readBeacon(keys, world.pkarr.get(keys.identity.pubKeyZ32) ?? []), world.now).map(h => h.key).sort();
    // One hub's reads of the beacon fail for a minute, through two of its republications. (The one whose turn comes
    // last in this world: the other, republishing after it in the same second, would put itself back unseen.)
    world.failRead = (p, key) => p === hubs[1] && key === keys.identity.pubKeyZ32;
    let erased = false;
    for (let t = 0; t < 60_000; t += 1_000) { await world.run(1_000); erased ||= !listed().includes(keyOf(hubs[0])); }
    expect(erased).toBe(false);
    // Its own entry waits for a read; it is back once one works.
    world.failRead = null;
    await world.run(40_000);
    expect(listed()).toEqual(hubs.map(keyOf).sort());
  });

  it("a member waits for a hub that went away 20 s, up to a minute once it is back, and then goes to another", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, alice);
    await joinAll(world, id, link, [bob, carol]);
    await world.run(60_000);
    const everyone = [alice, bob, carol];
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgeTo = (p: Peer, to: Peer) => [...p.links].find(([, e]) => e.kind === "edge" && e.peer === keyOf(to))?.[0];
    const member = everyone.find(p => !p.groups.communities.isHub(id))!;
    const hub = everyone.find(p => p !== member && edgeTo(member, p))!;
    const other = everyone.find(p => p !== member && p !== hub)!;
    // Back, but its edge takes long to come up (cut): the member keeps waiting past 20 s.
    hub.online = false;
    await world.run(5_000);
    world.cut = (a, b) => (a === hub && b === member) || (a === member && b === hub);
    await world.restart(hub);
    await world.run(30_000);
    expect(edgeTo(member, hub)).toBeDefined();
    expect(edgeTo(member, other)).toBeUndefined();
    world.cut = null;
    await world.run(3_000);
    expect(world.view(member, id)?.community?.connected).toBe(1);
    expect(edgeTo(member, other)).toBeUndefined();
    // Gone for good: the member gives up on it after 20 s, not a minute, and asks the other hub.
    hub.online = false;
    const left = await world.until(() => !edgeTo(member, hub), 60_000);
    expect(left).toBeGreaterThan(20_000);
    expect(left).toBeLessThanOrEqual(22_000);
    expect(edgeTo(member, other)).toBeDefined();
    await world.until(() => world.view(member, id)?.community?.connected === 1, 60_000);
  });

  it("a join through the link that nobody answers yet is declined like an invitation: it stops, and the group is gone", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const { id, link } = await community(world, alice);
    alice.online = false;
    await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.run(5_000);
    // What `group list` shows: an invitation, still knocking. Declining it used to answer "No invitation to decline".
    expect(world.view(bob, id)).toMatchObject({ invitation: { viaLink: true, accepted: true } });
    await bob.groups.decline(id);
    expect(world.view(bob, id)).toBeUndefined();
    await world.run(5_000);
    expect(world.view(bob, id)).toBeUndefined();
    await expect(alice.groups.decline(id), "a member, not a join under way").rejects.toThrow("No invitation to decline");
  });
});
