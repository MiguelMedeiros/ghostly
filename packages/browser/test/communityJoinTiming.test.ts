import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * How long a join through a community's link takes on headless engines when the network costs what
 * it costs on public relays (`RELAY_NETWORK`: each app's Pkarr budget, links that come up only after
 * both sides polled each other at `LinkSession`'s pace), step by step: the knock seen by a member
 * (its side of the entry session opened), the entry session up, in (the welcome), and the first edge
 * to a hub up. Each run is its own world; the distribution goes to `COMMUNITY_JOIN_OUT` when set.
 */
interface Timing { knockSeen?: number; entryUp?: number; member?: number; edgeUp?: number }

function seeded(seed: number): () => number {
  let x = Math.imul(seed, 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

/** Joins `joiner` and times each step (simulated ms from the click), `stepMs` apart. */
async function timeJoin(world: CommunityWorld, joiner: Peer, members: Peer[], id: string, link: string, limitMs = 5 * 60_000, stepMs = 500): Promise<Timing> {
  const start = world.now, t: Timing = {};
  const mark = (key: keyof Timing, done: boolean) => { if (done && t[key] === undefined) t[key] = world.now - start; };
  await joiner.groups.joinByLink(link);
  const key = [...joiner.links.values()].find(e => e.kind === "guest")?.me;
  await world.until(() => {
    const host = members.flatMap(m => [...m.links.values()]).filter(e => e.kind === "host" && e.peer === key);
    mark("knockSeen", host.length > 0);
    mark("entryUp", host.some(e => e.wasUp));
    mark("member", world.member(joiner, id));
    mark("edgeUp", t.member !== undefined && [...joiner.links.values()].some(e => e.kind === "edge" && e.g === id && e.upAt !== undefined));
    return t.edgeUp !== undefined;
  }, limitMs, stepMs);
  return t;
}

const percentile = (values: number[], p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : NaN;
function distribution(rows: Timing[]): Record<keyof Timing, { p50: number; p90: number; max: number }> {
  const out = {} as Record<keyof Timing, { p50: number; p90: number; max: number }>;
  for (const key of ["knockSeen", "entryUp", "member", "edgeUp"] as const) {
    const values = rows.map(r => r[key]).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    out[key] = { p50: percentile(values, 0.5) / 1000, p90: percentile(values, 0.9) / 1000, max: values[values.length - 1] / 1000 };
  }
  return out;
}
function report(name: string, rows: Timing[]): ReturnType<typeof distribution> {
  const d = distribution(rows);
  if (process.env.COMMUNITY_JOIN_OUT) appendFileSync(process.env.COMMUNITY_JOIN_OUT, JSON.stringify({ scenario: name, runs: rows.length, ...d, rows }) + "\n");
  return d;
}

const RUNS = Number(process.env.COMMUNITY_JOIN_RUNS ?? 12);

describe("a join through a community's link, timed on a network that costs what relays cost", { timeout: 240_000 }, () => {
  it("one member's app open a while: in within seconds, and at a hub soon after", async () => {
    const rows: Timing[] = [];
    for (let run = 0; run < RUNS; run++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK, seeded(run + 1));
      const alice = world.add("alice");
      const id = await alice.groups.create("Timing");
      const link = await alice.groups.enableLink(id);
      // Long enough for every periodic poll of a hub to be in its steady state, budget included.
      await world.run(3 * 60_000);
      // The link is opened at any moment of the member's polling cycles.
      await world.run(Math.floor(seeded(run + 99)() * 20) * 500, 500);
      rows.push(await timeJoin(world, world.add("bob"), [alice], id, link));
    }
    const d = report("one member open a while", rows);
    expect(d.member.p90).toBeLessThanOrEqual(10);
    expect(d.edgeUp.p90).toBeLessThanOrEqual(16);
  });

  it("the only member's app opens as the link is opened: it is the door at once", async () => {
    const rows: Timing[] = [];
    for (let run = 0; run < RUNS; run++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK, seeded(run + 1));
      const alice = world.add("alice");
      const id = await alice.groups.create("Timing");
      const link = await alice.groups.enableLink(id);
      await world.run(2 * 60_000);
      // Closed for a while (its beacon entry went stale), then opened as someone opens the link.
      alice.online = false;
      await world.run(3 * 60_000);
      await world.run(Math.floor(seeded(run + 99)() * 10) * 500, 500);
      alice.online = true;
      rows.push(await timeJoin(world, world.add("bob"), [alice], id, link));
    }
    const d = report("the only member opens as the link is opened", rows);
    expect(d.member.p90).toBeLessThanOrEqual(12);
    expect(d.edgeUp.p90).toBeLessThanOrEqual(18);
  });

  it("several members online: one door answers, in within seconds", async () => {
    const rows: Timing[] = [];
    for (let run = 0; run < Math.ceil(RUNS / 2); run++) {
      const world = new CommunityWorld(undefined, RELAY_NETWORK, seeded(run + 1));
      const alice = world.add("alice");
      const id = await alice.groups.create("Timing");
      const link = await alice.groups.enableLink(id);
      const members = [alice];
      for (const name of ["carol", "dave", "erin"]) {
        const p = world.add(name);
        await timeJoin(world, p, members, id, link);
        members.push(p);
      }
      await world.run(3 * 60_000);
      await world.run(Math.floor(seeded(run + 99)() * 20) * 500, 500);
      const timing = await timeJoin(world, world.add("bob"), members, id, link);
      rows.push(timing);
      // One door: nobody else opened a session for this joiner.
      expect(members.filter(m => [...m.links.values()].some(e => e.kind === "host")).length).toBeLessThanOrEqual(1);
    }
    const d = report("four members online", rows);
    expect(d.member.p90).toBeLessThanOrEqual(10);
    expect(d.edgeUp.p90).toBeLessThanOrEqual(16);
  });
});
