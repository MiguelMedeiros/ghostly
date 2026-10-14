import { describe, expect, it } from "vitest";
import { lobbyKeys } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.catch-up

/**
 * A member whose app was closed a couple of minutes (a web page closed and opened again) while its hub's app ran on:
 * the hub dropped its edge a minute after it went (`memberGoneMs`), so the member is taken back through the hub's lobby.
 */
describe("a community member back within minutes", { timeout: 60_000 }, () => {
  for (const gap of [125_000, 145_000]) it(`gets the lines said while its app was closed (${gap / 1000} s) within seconds, from the hub it had`, async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol"), dave = world.add("dave");
    const id = await alice.groups.create("Check");
    const link = await alice.groups.enableLink(id);
    for (const p of [bob, carol, dave]) {
      await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
      await world.until(() => world.member(p, id), 10 * 60_000);
    }
    await world.run(3 * 60_000);
    const everyone = [alice, bob, carol, dave], keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    // A member of one hub, and another hub it has no edge with.
    const member = everyone.find(p => !p.groups.communities.isHub(id))!;
    const others = everyone.filter(p => p !== member);
    const edgeTo = (p: Peer, to: Peer) => [...p.links.values()].some(e => e.kind === "edge" && e.peer === keyOf(to));
    const hub = others.find(p => edgeTo(member, p))!;
    expect(hub.groups.communities.isHub(id)).toBe(true);
    expect(others.some(p => p !== hub && p.groups.communities.isHub(id))).toBe(true);
    member.online = false;
    await world.run(gap - 5_000);
    expect(edgeTo(hub, member)).toBe(false);
    for (const p of others) await p.groups.send(id, `closed from ${p.name}`);
    await world.run(5_000);
    await world.restart(member);
    const took = await world.until(() => others.every(p => world.texts(member, id).includes(`closed from ${p.name}`)), 3 * 60_000);
    // It asked the hub of its last run, whose lobby is read fast a while after it dropped a member, not every half
    // minute: 13 and 23 s here before (8-23 s past a minute away; 30-45 s with the relays' signaling on top).
    expect(took).toBeLessThanOrEqual(7_000);
    expect(edgeTo(member, hub) && edgeTo(hub, member)).toBe(true);
  });

  it("a hub reads its lobby fast only a while after it dropped a member", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol"), dave = world.add("dave");
    const id = await alice.groups.create("Check");
    const link = await alice.groups.enableLink(id);
    for (const p of [bob, carol, dave]) {
      await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
      await world.until(() => world.member(p, id), 10 * 60_000);
    }
    await world.run(3 * 60_000);
    const everyone = [alice, bob, carol, dave], keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const member = everyone.find(p => !p.groups.communities.isHub(id))!;
    const hub = everyone.find(p => p !== member && [...member.links.values()].some(e => e.kind === "edge" && e.peer === keyOf(p)))!;
    const lobby = lobbyKeys(hub.groups.communities.session(id)!.state.rv, id, keyOf(hub)).identity.pubKeyZ32;
    const reads: number[] = [];
    world.onPkarr = (p, op, key) => { if (p === hub && op === "resolve" && key === lobby) reads.push(world.now); };
    const gone = world.now;
    member.online = false;
    await world.run(6 * 60_000);
    const within = (from: number, to: number) => reads.filter(at => at >= gone + from && at < gone + to).length;
    // Dropped a minute after it went: read every 6 s for two minutes, then every half minute again.
    expect(within(80_000, 170_000)).toBeGreaterThanOrEqual(12);
    expect(within(4 * 60_000, 6 * 60_000)).toBeLessThanOrEqual(5);
  });
});
