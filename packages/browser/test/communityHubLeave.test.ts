import { describe, expect, it } from "vitest";
import { beaconKeys, freshHubs, readBeacon } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
import { COMMUNITY_TIMINGS } from "../src/engine/community";
// covers: groups.community.leave, groups.protocol.community-topology

/**
 * A hub that leaves the group (the admin, most often: the first hub) says so on its edges before it goes. Its members
 * hold that signed request: they go to another hub at once, rather than waiting for it as for an app that restarts,
 * and the hub that commits the leave looks at its lobby soon, since that hub's members are about to ask it.
 */
async function settled(world: CommunityWorld, names: string[], settle = 90_000): Promise<{ id: string; peers: Peer[] }> {
  const peers = names.map(n => world.add(n));
  const [admin, ...rest] = peers;
  const id = await admin.groups.create("Town");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) {
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000);
  }
  await world.run(settle);
  return { id, peers };
}

const connected = (world: CommunityWorld, p: Peer, id: string) => world.view(p, id)?.community?.connected ?? 0;

describe("a hub that leaves", { timeout: 120_000 }, () => {
  for (const network of [null, RELAY_NETWORK]) it(`its members are on another hub within seconds, and the group talks again (${network ? "relay budget" : "free network"})`, async () => {
    const world = new CommunityWorld(undefined, network);
    const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"]);
    const [admin, ...rest] = peers;
    expect(admin.groups.communities.isHub(id)).toBe(true);
    // The members only the admin carries: the ones the leave cuts off.
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).map(e => e.peer);
    const orphans = rest.filter(p => !p.groups.communities.isHub(id) && edgesOf(p).every(k => k === keyOf(admin)));
    expect(orphans.length).toBeGreaterThan(0);

    await admin.groups.leave(id);
    const speaker = orphans[0];
    await speaker.groups.send(id, "still here?");
    const back = await world.until(() => rest.every(p => connected(world, p, id) > 0), 3 * 60_000);
    const heard = await world.until(() => rest.every(p => world.texts(p, id).includes("still here?")), 3 * 60_000);
    // Waiting for the hub as for an app restarting took 20 s to a minute, and the next hub's idle lobby poll 30 s more.
    expect(back).toBeLessThanOrEqual(20_000);
    expect(heard).toBeLessThanOrEqual(5_000);
  });
});

/**
 * The hub left behind has its relays' budget spent (it just let someone in, or carries most of the group): for a minute
 * it opens no new edge. The members the leaver carried then had no way back but through it. They asked it (the only hub
 * listed), waited a minute for it, and became hubs themselves, each with an edge to make to that same hub: the group
 * stayed in two parts for one to two minutes (real runs on relays, 2026-10-01 to 03). A member whose edge to that hub is
 * up already steps up instead, and those members go to it.
 */
describe("a hub that leaves while the hub left behind has its relays' budget spent", { timeout: 120_000 }, () => {
  it("a member connected to that hub carries the leaver's members, and the group talks again within seconds", async () => {
    // A group where the admin and one other member are the hubs, each carrying some of the others (which members a
    // hub takes is random: the first of a few groups that came out so).
    const edgesUp = (p: Peer, id: string) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => e.peer);
    let found: { world: CommunityWorld; id: string; admin: Peer; rest: Peer[]; left: Peer; orphans: Peer[]; carried: Peer[] } | undefined;
    for (let tries = 0; tries < 8 && !found; tries++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK);
      const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin", "frank", "grace"]);
      const [admin, ...rest] = peers;
      const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
      const hubs = rest.filter(p => p.groups.communities.isHub(id));
      if (!admin.groups.communities.isHub(id) || hubs.length !== 1) continue;
      const [left] = hubs, members = rest.filter(p => p !== left);
      const orphans = members.filter(p => edgesUp(p, id).every(k => k === keyOf(admin)));
      const carried = members.filter(p => edgesUp(p, id).includes(keyOf(left)) && !edgesUp(p, id).includes(keyOf(admin)));
      if (orphans.length && carried.length) found = { world, id, admin, rest, left, orphans, carried };
    }
    expect(found, "a group with the admin and one more member as hubs, each carrying members").toBeDefined();
    const { world, id, admin, rest, left, orphans, carried } = found!;
    const isHub = (p: Peer) => p.groups.communities.isHub(id);

    // Its budget spent for the next minute: it reads and writes nothing until then.
    left.spent = Array.from({ length: RELAY_NETWORK.budgetPerMinute }, () => world.now);
    await admin.groups.leave(id);
    for (const p of orphans) await p.groups.send(id, `${p.name} here`);
    const said = orphans.map(p => `${p.name} here`);
    const heard = await world.until(() => rest.every(p => said.every(t => p === orphans.find(o => `${o.name} here` === t) || world.texts(p, id).includes(t))), 3 * 60_000);
    // Before: the leaver's members waited a minute for the hub left behind and became hubs that reached nobody (60 s and more).
    expect(heard).toBeLessThanOrEqual(40_000);
    expect(carried.some(isHub), "a member connected to the hub left behind is a hub").toBe(true);
    for (const p of orphans) expect(isHub(p), `${p.name}, cut off by the leave, did not step up`).toBe(false);
  });
});

/**
 * A reading of the beacon that did not happen (the relays' budget held it back) is not an empty beacon. Taken as one, a
 * member became a hub at once and a hub took itself for the only one, and either published a beacon naming itself
 * alone: every other hub was out of it for everyone, the hubs opened no edge to each other, and the group stayed in
 * parts that did not hear each other (a real run on relays: two of four members without a message after 300 s).
 */
describe("a reading of the beacon the relays held back", { timeout: 120_000 }, () => {
  it("is not an empty beacon: a member does not become a hub on it, and no hub is published out of the beacon", async () => {
    const world = new CommunityWorld();
    const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"]);
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const keys = beaconKeys(peers[0].groups.communities.session(id)!.state.rv, id);
    const listed = () => freshHubs(readBeacon(keys, world.pkarr.get(keys.identity.pubKeyZ32) ?? []), world.now).map(h => h.key).sort();
    const hubs = peers.filter(p => p.groups.communities.isHub(id)), members = peers.filter(p => !p.groups.communities.isHub(id));
    expect(hubs.length).toBeGreaterThanOrEqual(2);
    expect(members.length).toBeGreaterThan(0);
    const before = hubs.map(keyOf).sort();
    expect(listed()).toEqual(before);

    // A member cannot read the beacon for a while.
    let unread: Peer = members[0];
    world.failRead = (peer, key) => peer === unread && key === keys.identity.pubKeyZ32;
    for (let s = 0; s < 40; s++) {
      await world.run(1000);
      expect(unread.groups.communities.isHub(id), `the member is a hub after ${s + 1} s without a reading`).toBe(false);
      expect(listed(), `the beacon after ${s + 1} s`).toEqual(before);
    }
    // A hub cannot: it keeps the hubs it knew, and publishes nothing over a record it did not read.
    unread = hubs[1];
    for (let s = 0; s < 40; s++) {
      await world.run(1000);
      expect(listed(), `the beacon ${s + 1} s after a hub lost its readings`).toEqual(before);
      expect(world.view(unread, id)?.community?.hubs, `the hubs that hub knows after ${s + 1} s`).toBe(before.length);
    }
    // Read again, it is listed as before, with the others.
    world.failRead = null;
    await world.run(40_000);
    expect(listed()).toEqual(before);
    for (const p of peers) expect(world.view(p, id)?.community?.connected, p.name).toBeGreaterThan(0);
  });
});

/**
 * Hubs elected in the same seconds (the members of a hub that left become hubs together) are idle in the same second
 * a minute later. Two of them with an edge to each other only both stepped down, each counting on the other: each was
 * then the other's hub, neither was one, and the two heard nobody else for minutes (a real run on relays: 194 s).
 */
describe("idle hubs stepping down", { timeout: 120_000 }, () => {
  it("two hubs that reach only each other do not both step down, each counting on the other", async () => {
    const timings = { ...COMMUNITY_TIMINGS, hubJitterMs: 0 };
    const world = new CommunityWorld(timings);
    const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"]);
    const isHub = (p: Peer) => p.groups.communities.isHub(id);
    const first = peers.filter(isHub), late = peers.filter(p => !isHub(p)).slice(0, 2);
    expect(first.length).toBe(2);
    expect(late.length).toBe(2);
    // Two members lose the hubs (not each other): no hub takes them, so each becomes one, and they open an edge to each other.
    world.cut = (a, b) => first.includes(a) !== first.includes(b) && (late.includes(a) || late.includes(b));
    await world.until(() => late.every(isHub), 3 * 60_000);
    const edgeUp = (a: Peer, b: Peer) => world.view(a, id)!.members.find(m => m.key === b.groups.communities.session(id)!.myKey)!.online;
    await world.until(() => edgeUp(late[0], late[1]) && edgeUp(late[1], late[0]), 60_000);
    // Idle a minute, four hubs listed, an edge up to another hub: before, both stepped down in the same second, and
    // each was the other's hub. Now one at most does, and only onto the other, which stays and knows it carries it.
    for (let s = 0; s < 4 * timings.idleHubMs / 1000; s++) {
      await world.run(1000);
      expect(late.some(isHub), `one of the two is a hub ${s + 1} s later`).toBe(true);
    }
    // The network is whole again: the four hubs meet, the two that came last may step down, and everyone hears everyone.
    world.cut = null;
    await late[0].groups.send(id, "anyone there?");
    const heard = await world.until(() => peers.every(p => world.texts(p, id).includes("anyone there?")), 3 * 60_000);
    expect(heard).toBeLessThanOrEqual(60_000);
    await world.run(4 * timings.idleHubMs);
    expect(peers.filter(isHub).length).toBeGreaterThanOrEqual(2);
    await peers[0].groups.send(id, "and now?");
    await world.until(() => peers.every(p => world.texts(p, id).includes("and now?")), 60_000);
    for (const p of peers) expect(world.view(p, id)?.community?.connected, p.name).toBeGreaterThan(0);
  });
});
