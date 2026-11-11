import { afterEach, describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS, COMMUNITY_TOPOLOGY } from "@ghostly/core";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * An online admin whose own hub is full still lets people in (WISP 903 § Admission through the link, § Admissions while
 * the admin is away). Its app was the door, but a hub at its capacity let the next hub in turn answer, so the admin never
 * admitted anyone: the other hubs, all members, stopped at the 32 admissions in a row the WISP allows them while the
 * admin is away, and a community whose admin keeps its app open stopped growing at about 90 (bug hunt, 2026-11-07: 64
 * members, 50 opening the link within a minute, 25 let in and the rest waiting for good). The admission is a commit;
 * the newcomer's edge goes to a hub with room, as when the member who let it in has none.
 */
const WAVE = 16;
type Live = { members: Map<string, number> };
const liveOf = (p: Peer, id: string) => (p.groups.communities as unknown as { live: Map<string, Live> }).live.get(id);
const keyOf = (p: Peer, id: string) => p.groups.communities.session(id)?.myKey;

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

/** A community of `n` built through its link in waves of 16, with the admin's app open throughout. */
async function community(seed: number, n: number) {
  const world = new CommunityWorld(undefined, null, seededRandom(seed));
  restore = sameRun(world, seed);
  const admin = world.add("admin");
  const id = await admin.groups.create("Crowd");
  const link = await admin.groups.enableLink(id);
  await world.run(5_000);
  for (let i = 1; i < n; i += WAVE) {
    const wave = Array.from({ length: Math.min(WAVE, n - i) }, (_, j) => world.add(`p${i + j}`));
    for (const p of wave) await p.groups.joinByLink(link);
    await world.until(() => wave.every(p => world.member(p, id)), 15 * 60_000, 1000, () => `wave ${i}: ${wave.filter(p => !world.member(p, id)).map(p => p.name).join(",")}`);
  }
  // The hubs settle and the last ones let in get their edges.
  await world.run(2 * 60_000);
  return { world, admin, id, link };
}

/** `count` people open the link, one a second; then the world runs until all are in or `limitMs` passed. */
async function storm(world: CommunityWorld, admin: Peer, id: string, link: string, count: number, limitMs: number) {
  const start = world.now, joiners: Peer[] = [];
  // The most members the admin's hub held at any second.
  let adminMembers = 0;
  const watch = () => { adminMembers = Math.max(adminMembers, liveOf(admin, id)?.members.size ?? 0); };
  for (let i = 0; i < count; i++) {
    const p = world.add(`s${i}`);
    joiners.push(p);
    await p.groups.joinByLink(link);
    await world.run(1_000);
    watch();
  }
  const done = () => { watch(); return joiners.every(p => world.member(p, id)); };
  await world.until(done, limitMs).catch(() => undefined);
  return { joiners, in: joiners.filter(p => world.member(p, id)).length, ms: world.now - start, adminMembers };
}

/** `add` commits signed by others than the admin since the admin's last admission, on `peer`'s chain (the WISP's count). */
function memberAdmissionsSinceAdmin(peer: Peer, id: string, admin: string): number {
  const chain = peer.groups.communities.session(id)!.state.chain;
  let n = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    if (c.k === "add" && c.by === admin) break;
    if (c.k === "add") n++;
  }
  return n;
}

describe("an online admin whose hub is full", { timeout: 600_000 }, () => {
  for (const seed of [11, 22, 33]) {
    it(`lets all of 50 joiners in, a minute's crowd at 64 members, its hub never past its capacity (seed ${seed})`, async () => {
      const { world, admin, id, link } = await community(seed, 64);
      // The admin's hub is full: the door with no room for one more member.
      expect(liveOf(admin, id)!.members.size).toBe(COMMUNITY_TOPOLOGY.hubCapacity);
      const r = await storm(world, admin, id, link, 50, 15 * 60_000);
      console.log(`seed ${seed}: ${r.in}/50 in after ${Math.round(r.ms / 1000)} s; admin's hub at most ${r.adminMembers}`);
      expect(r.in).toBe(50);
      expect(world.view(admin, id)!.members.length).toBe(114);
      // The newcomers' edges went to hubs with room: the admin's hub stayed within its bound, and each has an edge up.
      expect(r.adminMembers).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.hubCapacity);
      const connected = (p: Peer) => (world.view(p, id)?.community?.connected ?? 0) > 0, since = world.now;
      await world.until(() => { r.adminMembers = Math.max(r.adminMembers, liveOf(admin, id)?.members.size ?? 0); return r.joiners.every(connected); }, 5 * 60_000);
      console.log(`seed ${seed}: every joiner with an edge up ${Math.round((world.now - since) / 1000)} s after; admin's hub at most ${r.adminMembers}`);
      expect(r.adminMembers).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.hubCapacity);
      // Everyone online ends on the same roster, and a line from the last one let in reaches everyone.
      await world.until(() => [...world.peers.values()].every(p => world.view(p, id)?.members.length === 114), 5 * 60_000);
      const last = r.joiners[r.joiners.length - 1];
      await world.until(() => !!world.view(last, id)?.canSend, 2 * 60_000);
      await last.groups.send(id, "hello from the last one in");
      const reached = await world.until(() => [...world.peers.values()].every(p => world.texts(p, id).includes("hello from the last one in")), 5 * 60_000)
        .then(() => true, () => false);
      expect(reached).toBe(true);
    });
  }

  it("lets 16 joiners in at 64 members (control)", async () => {
    const { world, admin, id, link } = await community(11, 64);
    const r = await storm(world, admin, id, link, 16, 10 * 60_000);
    expect(r.in).toBe(16);
    expect(r.adminMembers).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.hubCapacity);
  });

  it("lets 50 joiners in at 32 members, its hub with room (control)", async () => {
    const { world, admin, id, link } = await community(11, 32);
    const r = await storm(world, admin, id, link, 50, 15 * 60_000);
    expect(r.in).toBe(50);
    expect(r.adminMembers).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.hubCapacity);
  });

  it("with the admin's app closed, members still stop at 32 admissions in a row", async () => {
    const { world, admin, id, link } = await community(11, 64);
    const adminKey = keyOf(admin, id)!, before = memberAdmissionsSinceAdmin(admin, id, adminKey), roster = world.view(admin, id)!.members.length;
    admin.online = false;
    const r = await storm(world, admin, id, link, 50, 10 * 60_000);
    // Nobody past the bound: the members' count since the admin's last admission stops at 32.
    const witness = r.joiners.find(p => world.member(p, id)) ?? [...world.peers.values()].find(p => p !== admin && world.member(p, id))!;
    expect(memberAdmissionsSinceAdmin(witness, id, adminKey)).toBe(COMMUNITY_LIMITS.memberAdmissions);
    expect(r.in).toBe(COMMUNITY_LIMITS.memberAdmissions - before);
    expect(world.view(witness, id)!.members.length).toBe(roster + r.in);
  });
});
