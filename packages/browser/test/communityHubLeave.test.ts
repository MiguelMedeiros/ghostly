import { describe, expect, it } from "vitest";
import { beaconKeys, freshHubs, lobbyKeys, readBeacon } from "@ghostly/core";
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
 * A hub whose app is killed says nothing: no leave request, no goodbye. Its members wait for it as for an app that
 * restarts, then ask a hub left. That hub read its lobby every half minute, and the member's side of the new edge looked
 * for it at the background pace, every half minute too: the group was cut in two for 54 s (2026-10-03).
 */
describe("a hub whose app is killed", { timeout: 120_000 }, () => {
  it("its members are on a hub left within half a minute, and the group talks again", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"], 20_000);
    const [admin, ...rest] = peers;
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const edgesUp = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => e.peer);
    expect(admin.groups.communities.isHub(id)).toBe(true);
    expect(rest.some(p => p.groups.communities.isHub(id)), "another hub").toBe(true);
    const orphans = rest.filter(p => !p.groups.communities.isHub(id) && edgesUp(p).every(k => k === keyOf(admin)));
    expect(orphans.length).toBeGreaterThan(0);

    // Each side of an edge to it dials it again at once, as the engine does: a connection under way, from one side.
    world.redialSeen = true;
    // The requests in the hubs' lobbies, and whether each went as the door's (not held while a link signals).
    const rv = rest[0].groups.communities.session(id)!.state.rv;
    const lobbies = new Set(rest.map(p => lobbyKeys(rv, id, keyOf(p)).identity.pubKeyZ32));
    const asked: { who: Peer; door: boolean }[] = [];
    world.onPkarr = (who, op, key, _bg, door) => { if (op === "publish" && lobbies.has(key)) asked.push({ who, door }); };
    admin.online = false;
    for (const p of rest) await p.groups.send(id, `line ${p.name}`);
    const back = await world.until(() => rest.every(p => connected(world, p, id) > 0), 3 * 60_000);
    const heard = await world.until(() => rest.every(p => rest.every(q => q === p || world.texts(p, id).includes(`line ${q.name}`))), 60_000);
    world.onPkarr = null;
    // 20 s waiting for the hub to come back, the hub left reads its lobby within 6 s, a few seconds of signaling.
    expect(back).toBeLessThanOrEqual(35_000);
    expect(heard).toBeLessThanOrEqual(5_000);
    // The hubs left stopped dialling it after the same 20 s its members wait for it: no edge to it is kept open.
    for (const hub of rest.filter(p => p.groups.communities.isHub(id))) expect([...hub.links.values()].some(e => e.kind === "edge" && e.g === id && e.peer === keyOf(admin)), `${hub.name} still dials the killed hub`).toBe(false);
    // Its members asked a hub left, and their requests went as a knock does, not held while their links dial.
    expect(asked.filter(a => orphans.includes(a.who)).length).toBeGreaterThan(0);
    expect(asked.every(a => a.door), "every request in a hub's lobby").toBe(true);
  });
});

/**
 * The hub left behind held the leaver's signed request, but counted the leaver as a hub until the leave was committed
 * (at once by the hub with the lowest key, half a minute later by any other) or its beacon entry went stale: it dialled
 * it again as one hub dials another, kept it at the door, and wrote it back into the beacon. An edge whose app is gone
 * looks fast for it, and on relays that held the hub's own requests (its lobby, its beacon entry) to the small share
 * they get while a link signals: five CLI daemons on local relays, the hub left behind read no lobby request for
 * minutes (2026-10-03).
 */
describe("the hubs a hub leaves behind", { timeout: 120_000 }, () => {
  it("count it out at once: no edge to it, and not in the beacon they write", async () => {
    const keyOf = (p: Peer, id: string) => p.groups.communities.session(id)!.myKey;
    // A group where the hub left behind does not commit the leave itself at once (the leaver's key is the lower one).
    let found: { world: CommunityWorld; id: string; admin: Peer; left: Peer } | undefined;
    for (let tries = 0; tries < 12 && !found; tries++) {
      const world = new CommunityWorld();
      const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave", "erin"]);
      const [admin, ...rest] = peers;
      const hubs = rest.filter(p => p.groups.communities.isHub(id));
      if (admin.groups.communities.isHub(id) && hubs.length === 1 && keyOf(admin, id) < keyOf(hubs[0], id)) found = { world, id, admin, left: hubs[0] };
    }
    expect(found, "a group with the admin and one more hub, the admin's key the lower").toBeDefined();
    const { world, id, admin, left } = found!;
    const gone = keyOf(admin, id);
    const keys = beaconKeys(left.groups.communities.session(id)!.state.rv, id);
    expect(world.view(left, id)!.community!.hubs).toBe(2);
    // Its app takes itself out of the beacon when the relays let it: here they do not (its budget is spent).
    world.failRead = peer => peer === admin;
    await admin.groups.leave(id);
    await world.run(2_000);
    for (let s = 0; s < 25; s++) {
      await world.run(1_000);
      // Not as a hub, nor to tell it it is out (it knows: it left).
      expect([...left.links.values()].some(e => e.kind === "edge" && e.g === id && e.peer === gone), `an edge to the leaver ${s + 3} s after`).toBe(false);
    }
    // What it writes in the beacon leaves the leaver out.
    await world.run(35_000);
    expect(readBeacon(keys, world.pkarr.get(keys.identity.pubKeyZ32) ?? []).map(h => h.key)).not.toContain(gone);
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

/**
 * A member asks a hub in its lobby; the relays may hold that write back (its budget, while one of its links signals).
 * It asked again only at the next refresh, 20 s later: a member cut off by a hub that left, whose first request was
 * refused, waited 20 s more for the hub that was to take it (CLI daemons on local relays, 2026-10-03).
 */
describe("a request in a hub's lobby the relays held back", { timeout: 120_000 }, () => {
  it("is made again in a moment, not at the next refresh", async () => {
    let found: { world: CommunityWorld; id: string; admin: Peer; hub: Peer; orphans: Peer[] } | undefined;
    const edgesUp = (p: Peer, id: string) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && e.upAt !== undefined).map(e => e.peer);
    const keyOf = (p: Peer, id: string) => p.groups.communities.session(id)!.myKey;
    for (let tries = 0; tries < 8 && !found; tries++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK);
      const { id, peers } = await settled(world, ["admin", "bob", "carol", "dave"]);
      const [admin, ...rest] = peers;
      const hubs = rest.filter(p => p.groups.communities.isHub(id));
      const orphans = rest.filter(p => !p.groups.communities.isHub(id) && edgesUp(p, id).every(k => k === keyOf(admin, id)));
      if (admin.groups.communities.isHub(id) && hubs.length === 1 && orphans.length) found = { world, id, admin, hub: hubs[0], orphans };
    }
    expect(found, "a group with the admin and one more hub, the admin carrying members").toBeDefined();
    const { world, id, admin, hub, orphans } = found!;
    const lobby = lobbyKeys(hub.groups.communities.session(id)!.state.rv, id, keyOf(hub, id)).identity.pubKeyZ32;
    // For the first seconds after the leave, the members it carried cannot reach the relays for that hub's lobby.
    const until = world.now + 3_000;
    world.failRead = (peer, key) => orphans.includes(peer) && key === lobby && world.now < until;
    await admin.groups.leave(id);
    const back = await world.until(() => orphans.every(p => edgesUp(p, id).includes(keyOf(hub, id))), 60_000);
    // Asked again 5 s after the refusal, read within the hub's 6 s, the edge in a moment: before, 20 s and more.
    expect(back).toBeLessThan(16_000);
  });
});
