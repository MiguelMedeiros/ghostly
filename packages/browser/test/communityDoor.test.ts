import { describe, expect, it } from "vitest";
import { DiscoveryBudgetError, EXPECT_PEER_MS, PRESENCE_WINDOW, MAX_KNOCKS, beaconKeys, createIdentity, decodeCommunityLink, entryParams, identityFromSeedB64, knockIdentity, lobbyKeys, publicKeyFromZ32, readBeacon, readKnocks, type GroupEntryLink } from "@ghostly/core";
import { COMMUNITY_TIMINGS, KNOCK_SHARDS, UNKNOCKED_RETRY_MS, dialedKey } from "../src/engine/community";
import { otherEndSeen } from "../src/engine/groups";
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

  it("a joiner's view says how many others knock with it, and stops once it is in", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const { id, link } = await community(world, alice);
    await world.run(5_000);
    // Nobody at the door while three people open the link.
    alice.online = false;
    const crowd = Array.from({ length: 3 }, (_, i) => world.add(`p${i}`));
    for (const p of crowd) { await p.groups.joinByLink(link); await landed(); }
    const waiting = (p: Peer) => world.view(p, id)?.invitation?.waiting;
    // Each saw who had knocked before it; a refresh of its knock shows it the rest.
    expect(crowd.map(waiting)).toEqual([undefined, 1, 2]);
    await world.run(COMMUNITY_TIMINGS.knockMs + 1_000);
    expect(crowd.map(waiting)).toEqual([2, 2, 2]);
    // One gives up: the others' count follows once its knock stops being refreshed.
    await crowd[2].groups.forget(id);
    await world.run(2 * COMMUNITY_TIMINGS.slowKnockMs + COMMUNITY_TIMINGS.knockMs + 1_000);
    expect(crowd.slice(0, 2).map(waiting)).toEqual([1, 1]);
    // A member's app opens: they are let in, and nothing waits any more.
    alice.online = true;
    await world.until(() => crowd.slice(0, 2).every(p => world.member(p, id)), 5 * 60_000);
    expect(crowd.slice(0, 2).map(p => world.view(p, id)?.invitation)).toEqual([undefined, undefined]);
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

  it("a joiner's key makes the member's side of the entry session the one that dials, at once", () => {
    for (let i = 0; i < 24; i++) {
      const entry = createIdentity(), link = { g: `g${i}`, host: entry.pubKeyZ32 };
      const me = identityFromSeedB64(dialedKey(link));
      const joinerSide = entryParams(link, me.seed, me.pubKeyZ32, link.host), memberSide = entryParams(link, entry.seed, entry.pubKeyZ32, me.pubKeyZ32);
      const joinerKey = identityFromSeedB64(joinerSide.seedB64).pubKeyZ32, memberKey = identityFromSeedB64(memberSide.seedB64).pubKeyZ32;
      // Both ends derive the same pair of session keys…
      expect(joinerSide.peerPubKeyZ32).toBe(memberKey);
      expect(memberSide.peerPubKeyZ32).toBe(joinerKey);
      // …and the member's is the lower one, which dials (`GhostLink`: only the lower key offers).
      expect(memberKey < joinerKey).toBe(true);
    }
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

  // Miguel's CLI (2026-09-30): a daemon that had just let people into two other communities created a third, and
  // its door first answered a knock 43 to 65 s later. A hub is at the door once its beacon entry is listed, and that
  // write is a background request: while a link signals (the last admission's edge, still looking fast), background
  // requests get 5 a minute on each relay, which the other doors' bell reads (exempt from that share) took. Here the
  // relays' budget holds the new hub's beacon writes back for a minute; everything else goes through.
  it("a new group's first hub is its door at once, though the relays' budget holds its beacon entry back", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, link } = await community(world, alice);
    const beacon = beaconKeys(alice.groups.communities.session(id)!.state.rv, id);
    const heldUntil = world.now + 60_000, publish = alice.host.publish;
    let held = 0;
    alice.host.publish = async (identity, records, background) => {
      if (identity.pubKeyZ32 === beacon.identity.pubKeyZ32 && world.now < heldUntil) { held++; throw new DiscoveryBudgetError(heldUntil - world.now); }
      return publish(identity, records, background);
    };
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    const answered = await world.until(() => [...alice.links.values()].some(e => e.kind === "host" && e.g === id), 60_000, 500);
    expect(held).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(5_000);
    await world.until(() => world.member(bob, id), 60_000, 500);
    // Once the budget lets it, its entry is listed, as any hub's.
    await world.run(heldUntil - world.now + 10_000, 500);
    expect(readBeacon(beacon, world.pkarr.get(beacon.identity.pubKeyZ32) ?? []).map(h => h.key)).toContain(alice.groups.communities.session(id)!.myKey);
  });

  it("a joiner whose knock the relays' budget refused knocks again within seconds, as a first knock, not a background refresh", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, link, entry } = await community(world, alice);
    const bob = world.add("bob");
    // Its budget spent elsewhere (the door of another community, say): its knocks are refused for 20 s.
    const bell = recordKey(entry, 0), heldUntil = world.now + 20_000, publish = bob.host.publish;
    const tries: { at: number; background: boolean }[] = [];
    bob.host.publish = async (identity, records, background, door) => {
      if (identity.pubKeyZ32 === bell) {
        tries.push({ at: world.now, background: !!background });
        if (world.now < heldUntil) throw new DiscoveryBudgetError(heldUntil - world.now);
      }
      return publish(identity, records, background, door);
    };
    await bob.groups.joinByLink(link);
    await world.until(() => tries.some(t => t.at >= heldUntil), 60_000, 500);
    const out = tries.find(t => t.at >= heldUntil)!;
    // Every try until one went out was a first knock, a few seconds apart. As background refreshes every 10 s, the
    // budget held them back further while the joiner's entry session looked fast for an answer.
    expect(tries.filter(t => t.at <= out.at).map(t => t.background)).toEqual(tries.filter(t => t.at <= out.at).map(() => false));
    expect(out.at - heldUntil).toBeLessThanOrEqual(UNKNOCKED_RETRY_MS + 1_000);
    expect(world.view(bob, id)?.invitation?.stage).not.toBe("knocking");
    await world.until(() => world.member(bob, id), 60_000, 500);
  });

  it("a knock the relays' budget refused goes again first, from the bell it read, not after a read of its own", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, link, entry } = await community(world, alice);
    const bob = world.add("bob");
    // Its first knock read the bell, and the write after it was refused. The relays' budget keeps the next request it
    // frees for that write (`WRITE_FIRST_MS`): a group read is held back meanwhile.
    const bell = recordKey(entry, 0), ops: { at: number; op: string }[] = [];
    const publish = bob.host.publish, resolve = bob.host.resolve;
    let refusedAt: number | undefined;
    const writeFirst = () => refusedAt !== undefined && !ops.some(o => o.op === "write") && world.now - refusedAt < RELAY_NETWORK.writeFirstMs;
    bob.host.resolve = async (key, background, door) => {
      if (key !== bell) return resolve(key, background, door);
      if (writeFirst()) { ops.push({ at: world.now, op: "read refused" }); throw new DiscoveryBudgetError(refusedAt! + RELAY_NETWORK.writeFirstMs - world.now); }
      const found = await resolve(key, background, door);
      ops.push({ at: world.now, op: "read" });
      return found;
    };
    bob.host.publish = async (identity, records, background, door) => {
      if (identity.pubKeyZ32 === bell && refusedAt === undefined) {
        refusedAt = world.now; ops.push({ at: world.now, op: "write refused" });
        throw new DiscoveryBudgetError(RELAY_NETWORK.writeFirstMs);
      }
      await publish(identity, records, background, door);
      if (identity.pubKeyZ32 === bell) ops.push({ at: world.now, op: "write" });
    };
    await bob.groups.joinByLink(link);
    await world.until(() => ops.some(o => o.op === "write"), 60_000, 500);
    // The write goes at the first retry, with no read before it. Before, that retry read the bell first: the read was
    // held back for the write's turn, the knock failed with it, and the write went only at the retry after (6 s).
    expect(ops.map(o => `${o.op} +${o.at - refusedAt!}`)).toEqual(["read +0", "write refused +0", `write +${UNKNOCKED_RETRY_MS}`]);
    expect(knocksIn(world, entry, 0)).toContain(guestKey(bob));
    await world.until(() => world.member(bob, id), 60_000, 500);
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

  it("in a group's first minute, a member that just became a hub leaves the knock to the first hub", async () => {
    // The first hub, alone in the beacon, reads it only when it republishes: for half a minute it does not know that
    // the first member let in became a hub. That member used to count both of them at the door and, with the lower
    // key, answer the next knock too: two hubs on one entry session (in this world, nobody gets in through either).
    let lower = 0;
    for (let run = 0; run < 40 && lower < 3; run++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK);
      const alice = world.add("alice"), made = world.now;
      const { id, link } = await community(world, alice);
      await world.run(5_000);
      const bob = world.add("bob");
      await bob.groups.joinByLink(link);
      // Only where the newcomer's key is the lower one did it take the door (half the groups).
      if (guestKey(bob) > world.view(alice, id)!.myKey!) continue;
      lower++;
      await world.until(() => bob.groups.communities.isHub(id), 60_000, 500);
      expect(world.now - made).toBeLessThan(60_000);
      const carol = world.add("carol");
      await carol.groups.joinByLink(link);
      const key = guestKey(carol);
      let answering = 0;
      const took = await world.until(() => {
        answering = Math.max(answering, [alice, bob].filter(p => [...p.links.values()].some(e => e.kind === "host" && e.peer === key)).length);
        return world.member(carol, id);
      }, 60_000, 500, () => `${answering} hubs answered the knock`);
      expect(answering).toBe(1);
      expect(took).toBeLessThanOrEqual(12_000);
    }
    expect(lower).toBe(3);
  });
});

describe("a joiner away while the door let it in", { timeout: 120_000 }, () => {
  // Miguel's CLI (2026-09-30): a daemon stopped just after joining through the link. The door answered the knock and
  // gave its entry session up 90 s later, unanswered; the joiner, back later, knocked again and waited for the door's
  // next turn, up to two minutes, though a lone door has no other hub to take turns with.
  it.each([0, 20_000, 60_000])("back %i ms after the door gave up: a lone door lets it in within seconds", async after => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const alice = world.add("alice");
    const { id, link } = await community(world, alice);
    await world.run(3 * 60_000);
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    await landed();
    bob.online = false;
    // The door sees the knock, opens its side of the entry session, and gives it up unanswered.
    await world.until(() => [...alice.links.values()].some(e => e.kind === "host"), 60_000);
    await world.until(() => ![...alice.links.values()].some(e => e.kind === "host"), 3 * 60_000);
    await world.run(after);
    await world.restart(bob);
    const took = await world.until(() => world.member(bob, id), 5 * 60_000);
    expect(took).toBeLessThanOrEqual(20_000);
  });
});

describe("what counts as the member's side of an entry session answering (the engine's linkSeen)", () => {
  const NOW = 1_800_000_000_000;
  const presence = (age: number, online = true) => ({ online, lastPacketAt: NOW - age, services: online ? [] : null });

  it("a connection under way, whatever its packet says", () => {
    for (const state of ["offering", "answering", "connecting", "open"]) expect(otherEndSeen(undefined, state, NOW)).toBe(true);
    expect(otherEndSeen(undefined, "idle", NOW)).toBe(false);
  });

  // The hub closes an entry it gave up on without a last packet: a joiner back after a restart read that packet, still
  // "online" for PRESENCE_WINDOW, as a member answering, stopped knocking, and stayed "invited" 10 minutes (2026-09-30).
  it("a packet only while it is fresh: a hub's side given up on is not answering, though its presence has not lapsed", () => {
    expect(otherEndSeen(presence(1_000), "idle", NOW)).toBe(true);
    expect(otherEndSeen(presence(EXPECT_PEER_MS - 1), "idle", NOW)).toBe(true);
    expect(otherEndSeen(presence(EXPECT_PEER_MS), "idle", NOW)).toBe(false);
    expect(otherEndSeen(presence(PRESENCE_WINDOW / 2), "idle", NOW)).toBe(false);
    expect(otherEndSeen(presence(1_000, false), "idle", NOW)).toBe(false);
  });
});

/**
 * A hub's own records (its lobby, the beacon it reads and writes) go as the door's bell does: background requests, but
 * not held to the share they get while a link signals (`PkarrRequestOptions.door`). The members of a hub that left all
 * ask a hub left at once, and the edges it opens for them signal: held to that share, the hub read its lobby and wrote
 * its beacon entry late, and the members still asking waited for those edges (CLI daemons on local relays, 2026-10-03).
 */
describe("a hub's own lobby and beacon", { timeout: 120_000 }, () => {
  it("go as its bell does; a member's looks at the beacon do not", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const { id, link } = await community(world, admin);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    await world.run(60_000);
    const keyOf = (p: Peer) => p.groups.communities.session(id)!.myKey;
    const rv = admin.groups.communities.session(id)!.state.rv;
    const beacon = beaconKeys(rv, id).identity.pubKeyZ32;
    const lobbyOf = (p: Peer) => lobbyKeys(rv, id, keyOf(p)).identity.pubKeyZ32;
    const hub = [admin, bob, carol].find(p => p.groups.communities.isHub(id))!;
    const member = [admin, bob, carol].find(p => !p.groups.communities.isHub(id))!;
    const seen: { who: Peer; op: string; key: string; door: boolean }[] = [];
    world.onPkarr = (who, op, key, _bg, door) => { seen.push({ who, op, key, door }); };
    await world.run(70_000);
    world.onPkarr = null;
    const ofHub = seen.filter(r => r.who === hub && (r.key === beacon || r.key === lobbyOf(hub)));
    expect(ofHub.some(r => r.key === lobbyOf(hub) && r.op === "resolve")).toBe(true);
    expect(ofHub.some(r => r.key === beacon && r.op === "publish")).toBe(true);
    expect(ofHub.every(r => r.door), "every request of the hub for its lobby and the beacon").toBe(true);
    const ofMember = seen.filter(r => r.who === member && r.key === beacon);
    expect(ofMember.length).toBeGreaterThan(0);
    expect(ofMember.some(r => r.door)).toBe(false);
  });
});
