import { describe, expect, it } from "vitest";
import { MAX_KNOCKS, decodeCommunityLink, identityFromSeedB64, knockIdentity, lobbyKeys, publicKeyFromZ32, readKnocks, type GroupEntryLink } from "@ghostly/core";
import { COMMUNITY_TIMINGS, KNOCK_SHARDS } from "../src/engine/community";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.join, groups.protocol.community-topology

/**
 * The door of a community (`packages/browser/src/engine/community.ts`): where knocks go and how
 * often the door reads them, what that costs in Pkarr requests, how fast a lone member becomes the
 * door, and the newcomer's first edge. `communityJoinTiming.test.ts` times whole joins.
 */
const record = (link: GroupEntryLink, n: number) => ({ g: `${link.g}.${n}`, host: link.host });
const recordKey = (link: GroupEntryLink, n: number) => knockIdentity(record(link, n)).pubKeyZ32;
const knocksIn = (world: CommunityWorld, link: GroupEntryLink, n: number) => readKnocks(record(link, n), world.pkarr.get(recordKey(link, n)) ?? []).map(k => k.key);
const guestKey = (p: Peer) => [...p.links.values()].find(e => e.kind === "guest")!.me;
/** The knock goes out asynchronously after `joinByLink`: let it land. */
const landed = () => new Promise(resolve => setTimeout(resolve, 5));

/** Pkarr reads by one app over the next `ms`, per key. */
async function readsOver(world: CommunityWorld, peer: Peer, ms: number): Promise<{ reads: Map<string, number>; background: number; foreground: number }> {
  const reads = new Map<string, number>();
  let background = 0, foreground = 0;
  world.onPkarr = (p, op, key, bg) => {
    if (p !== peer) return;
    if (op === "resolve") reads.set(key, (reads.get(key) ?? 0) + 1);
    const cost = op === "resolve" ? 1 : 2;
    if (bg) background += cost; else foreground += cost;
  };
  await world.run(ms, 500);
  world.onPkarr = null;
  return { reads, background, foreground };
}

async function community(world: CommunityWorld, admin: Peer): Promise<{ id: string; link: string; entry: GroupEntryLink }> {
  const id = await admin.groups.create("Door");
  const link = await admin.groups.enableLink(id);
  return { id, link, entry: decodeCommunityLink(link)! };
}

describe("a community's door", { timeout: 120_000 }, () => {
  it("knocks go to the bell; once a crowd has filled it, to the joiner's own record, which the door reads too", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const { id, link, entry } = await community(world, alice);
    await world.run(5_000);
    // Nobody at the door while they knock.
    alice.online = false;
    const crowd = Array.from({ length: MAX_KNOCKS }, (_, i) => world.add(`p${i}`));
    for (const p of crowd) { await p.groups.joinByLink(link); await landed(); }
    const bell = knocksIn(world, entry, 0);
    expect(bell).toHaveLength(MAX_KNOCKS - 1);
    expect(bell).toEqual(crowd.slice(0, -1).map(guestKey));
    // The last one found the bell full: its own record, 1 to 3 from its key.
    const last = guestKey(crowd[crowd.length - 1]), own = 1 + publicKeyFromZ32(last)[0] % (KNOCK_SHARDS - 1);
    expect(knocksIn(world, entry, own)).toEqual([last]);
    // A member's app opens: everyone is let in, the one in its own record too, one admission at a time.
    alice.online = true;
    await world.until(() => crowd.every(p => world.member(p, id)), 10 * 60_000);
    expect(world.view(alice, id)?.epoch).toBe(crowd.length);
  });

  it("a lone door reads the bell every few seconds and the other records now and then, within its share of the relays' budget", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { entry } = await community(world, alice);
    await world.run(3 * 60_000);
    const { reads, background, foreground } = await readsOver(world, alice, 60_000);
    const bell = reads.get(recordKey(entry, 0)) ?? 0;
    expect(bell).toBeGreaterThanOrEqual(60_000 / COMMUNITY_TIMINGS.knockPollMs - 2);
    expect(bell).toBeLessThanOrEqual(60_000 / COMMUNITY_TIMINGS.knockPollMs + 1);
    const others = Array.from({ length: KNOCK_SHARDS - 1 }, (_, i) => reads.get(recordKey(entry, i + 1)) ?? 0).reduce((a, b) => a + b, 0);
    expect(others).toBeGreaterThanOrEqual(1);
    expect(others).toBeLessThanOrEqual(60_000 / COMMUNITY_TIMINGS.knockShardPollMs + 1);
    // All of it in the background, and under half the budget: a join signals two links at once, and they find the rest.
    expect(foreground).toBe(0);
    expect(background).toBeLessThanOrEqual(RELAY_NETWORK.budgetPerMinute / 2);
    expect(alice.refused).toBe(0);
  });

  it("reads faster for a while after the link is shown, and slower while letting someone in", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, entry } = await community(world, alice);
    await world.run(3 * 60_000);
    await alice.groups.enableLink(id);
    const warm = (await readsOver(world, alice, 30_000)).reads.get(recordKey(entry, 0)) ?? 0;
    expect(warm).toBeGreaterThanOrEqual(30_000 / COMMUNITY_TIMINGS.knockWarmPollMs - 2);
    await world.run(60_000);
    // A joiner whose side of the entry session never comes up (its app closed right after knocking).
    const bob = world.add("bob");
    await bob.groups.joinByLink(await alice.groups.enableLink(id));
    await landed();
    bob.online = false;
    await world.until(() => [...alice.links.values()].some(e => e.kind === "host"), 30_000, 500);
    const busy = (await readsOver(world, alice, 30_000)).reads.get(recordKey(entry, 0)) ?? 0;
    expect(busy).toBeLessThanOrEqual(30_000 / COMMUNITY_TIMINGS.knockBusyPollMs + 1);
  });

  it("only the door reads the bell fast; the other hubs at the door look now and then, for their turn", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, link, entry } = await community(world, alice);
    const others = ["bob", "carol", "dave"].map(n => world.add(n));
    for (const p of others) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000, 500); }
    await world.run(3 * 60_000);
    const everyone = [alice, ...others], hubs = everyone.filter(p => p.groups.communities.isHub(id));
    expect(hubs.length).toBeGreaterThanOrEqual(2);
    const bells = new Map<Peer, number>();
    world.onPkarr = (p, op, key) => { if (op === "resolve" && key === recordKey(entry, 0)) bells.set(p, (bells.get(p) ?? 0) + 1); };
    await world.run(60_000, 500);
    world.onPkarr = null;
    const counts = hubs.map(p => bells.get(p) ?? 0).sort((a, b) => b - a);
    expect(counts[0]).toBeGreaterThanOrEqual(60_000 / COMMUNITY_TIMINGS.knockPollMs - 2);
    for (const other of counts.slice(1)) expect(other).toBeLessThanOrEqual(60_000 / COMMUNITY_TIMINGS.otherHubKnockPollMs / KNOCK_SHARDS + 2);
    // Members that are not hubs read no knocks at all.
    for (const p of everyone.filter(p => !hubs.includes(p))) expect(bells.get(p) ?? 0).toBe(0);
  });

  it("with no hub at all, a member's app that opens is the door at once, without the random wait", async () => {
    const world = new CommunityWorld({ ...COMMUNITY_TIMINGS, hubJitterMs: 60_000 });
    const alice = world.add("alice");
    const { id } = await community(world, alice);
    await world.run(10_000);
    alice.online = false;
    await world.run(3 * 60_000);
    alice.online = true;
    await world.run(1_000);
    expect(alice.groups.communities.isHub(id)).toBe(true);
  });

  it("the member let in gets its edge from both sides at once, each looking fast, without the lobby; it is a hub only later", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const { id, link } = await community(world, alice);
    await world.run(5_000);
    const published = new Set<string>();
    world.onPkarr = (p, op, key) => { if (p === bob && op === "publish") published.add(key); };
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 60_000);
    await world.settle();
    const aliceKey = alice.groups.communities.session(id)!.myKey, bobKey = bob.groups.communities.session(id)!.myKey;
    const edge = (p: Peer, to: string) => [...p.links.values()].find(e => e.kind === "edge" && e.peer === to);
    expect(edge(bob, aliceKey)?.expected).toBe(true);
    expect(edge(alice, bobKey)?.expected).toBe(true);
    expect(edge(bob, aliceKey)?.upAt ?? world.view(bob, id)?.community?.connected).toBeTruthy();
    await world.run(10_000);
    world.onPkarr = null;
    const lobby = lobbyKeys(bob.groups.communities.session(id)!.state.rv, id, aliceKey).identity.pubKeyZ32;
    expect(published.has(lobby)).toBe(false);
    // Two members want two hubs: the newcomer is the second, once settled in.
    expect(bob.groups.communities.isHub(id)).toBe(false);
    await world.run(COMMUNITY_TIMINGS.newcomerMs);
    expect(bob.groups.communities.isHub(id)).toBe(true);
    expect(identityFromSeedB64(bob.groups.communities.session(id)!.state.seedB64).pubKeyZ32).toBe(bobKey);
  });
});
