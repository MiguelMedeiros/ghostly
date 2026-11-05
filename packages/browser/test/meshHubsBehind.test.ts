import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.catch-up

/**
 * A member of a private group on hubs that comes back behind the chain, after every hub it knew left or closed
 * (WISP 902 · Group Mesh § Hubs, Stand-ins; agents#2491). The real `Groups`, `MeshHubs` and `GroupSession` on headless
 * engines, Pkarr and links in memory, simulated clock, 20 members. Member `x` (p1, not a hub) has hubs p2 and p5; while
 * its app is closed the hubs change, the others write three lines, then it comes back.
 */

interface Built { world: CommunityWorld; id: string; link: string; admin: Peer; peers: Peer[] }

async function build(n: number, hubs: number[]): Promise<Built> {
  const world = new CommunityWorld();
  const admin = world.add("admin", undefined, { staysOnline: hubs.includes(0) });
  const id = await admin.groups.create("Hubs", "mesh");
  const link = await admin.groups.enableLink(id);
  const peers = [admin];
  for (let i = 1; i < n; i++) {
    const p = world.add(`p${i}`, undefined, { staysOnline: hubs.includes(i) });
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000, 500);
    peers.push(p);
  }
  return { world, id, link, admin, peers };
}

const view = (b: Built, p: Peer) => b.world.view(p, b.id)!;
const keyOf = (b: Built, p: Peer) => view(b, p).myKey!;
const hubKeys = (b: Built, p: Peer) => view(b, p).members.filter(m => m.hub && !m.me).map(m => m.key).sort();
/** Holds the epoch the admin is at, and its secret. */
const current = (b: Built, p: Peer) => view(b, p).epoch === view(b, b.admin).epoch && view(b, p).canSend;
/** The members in `ps` that hold an edge to `x` (open on their side). */
const holding = (b: Built, x: Peer, ps: Peer[]) => ps.filter(p => [...p.links.values()].some(e => e.kind === "edge" && e.g === b.id && e.peer === keyOf(b, x))).map(p => p.name);
const allReach = (b: Built, ps: Peer[]) => ps.every(p => view(b, p).members.length === ps.length && view(b, p).members.every(m => m.online));

async function join(b: Built, name: string, staysOnline: boolean): Promise<Peer> {
  const p = b.world.add(name, undefined, { staysOnline });
  await p.groups.joinByLink(b.link);
  await b.world.until(() => b.world.member(p, b.id), 5 * 60_000, 500);
  return p;
}

/** The group on hubs p2 and p5 (and `extra` hubs), settled: every member reaches every other, x counts on p2 and p5. */
async function settled(extra: number[] = []) {
  const b = await build(20, [2, 5, ...extra]);
  const { world, peers } = b;
  await world.until(() => peers.every(p => !!view(b, p).hubs) && allReach(b, peers), 10 * 60_000, 1000);
  await world.run(150_000);
  const x = peers[1];
  return { b, world, x };
}

/** x is back: how long until it holds the lines written meanwhile and the roster everyone else has (undefined: never within `limitMs`). */
async function back(b: Built, x: Peer, lines: string[], limitMs = 10 * 60_000): Promise<number | undefined> {
  const roster = () => view(b, b.admin).members.map(m => m.key).sort().join();
  b.world.reopen(x);
  try {
    return await b.world.until(() => lines.every(l => b.world.texts(x, b.id).includes(l)) && view(b, x).members.map(m => m.key).sort().join() === roster(), limitMs, 1000);
  } catch {
    return undefined;
  }
}

describe("a member back behind the chain after every hub it knew went", () => {
  it("C4A: p2 leaves, a newcomer joins and is the hub, p5 closes: x still reaches the group and catches up", async () => {
    const { b, world, x } = await settled();
    const [p2, p5] = [b.peers[2], b.peers[5]];
    expect(hubKeys(b, x)).toEqual([keyOf(b, p2), keyOf(b, p5)].sort());
    x.online = false;
    await p2.groups.leave(b.id);
    await world.until(() => view(b, b.admin).members.length === 19, 60_000, 500);
    const newhub = await join(b, "newhub", true);
    await world.until(() => view(b, newhub).hubs?.hub === true, 5 * 60_000, 1000);
    p5.online = false;
    const online = b.peers.filter(p => ![x, p2, p5].includes(p)).concat(newhub);
    // The others move to the newcomer: every one of them on hubs, reaching every other but x and p5.
    await world.until(() => online.every(p => view(b, p).hubs && current(b, p) && view(b, p).members.filter(m => !m.me && m.key !== keyOf(b, x) && m.key !== keyOf(b, p5)).every(m => m.online)), 10 * 60_000, 1000);
    const lines = ["while away 1", "while away 2", "while away 3"];
    for (const [i, line] of lines.entries()) { await b.peers[[3, 4, 6][i]].groups.send(b.id, line); await world.run(2_000); }
    for (const p of online) for (const line of lines) expect(world.texts(p, b.id)).toContain(line);
    // Meanwhile x has two stand-ins: members the hub reaches, that keep an edge for it (all it costs the group), and the hub.
    expect(holding(b, x, online)).toHaveLength(1 + 2);
    expect(holding(b, x, online)).toContain(newhub.name);
    const took = await back(b, x, lines);
    // Before the fix: never (x read its old epoch's beacon, dialed the members it knew, and none of them opened its side).
    expect(took, `x has ${lines.filter(l => world.texts(x, b.id).includes(l)).length}/3 lines, ${view(b, x).members.length} in its roster`).toBeDefined();
    expect(took!).toBeLessThanOrEqual(2 * 60_000);
    // Caught up, it is on hubs again: its edges are back to its hubs (and nobody keeps one for it any more).
    await world.until(() => !!view(b, x).hubs && hubKeys(b, x).includes(keyOf(b, newhub)), 5 * 60_000, 1000);
    // Its stand-ins drop their edges once a hub reaches it.
    await world.run(120_000);
    expect(holding(b, x, online)).toEqual([newhub.name]);
    await x.groups.send(b.id, "x is back");
    await world.run(3_000);
    for (const p of online) expect(world.texts(p, b.id)).toContain("x is back");
  }, 300_000);

  it("C4B (control): the same, but p5 stays online: x catches up through it", async () => {
    const { b, world, x } = await settled();
    const p2 = b.peers[2];
    x.online = false;
    await p2.groups.leave(b.id);
    await world.until(() => view(b, b.admin).members.length === 19, 60_000, 500);
    const newhub = await join(b, "newhub", true);
    await world.until(() => view(b, newhub).hubs?.hub === true, 5 * 60_000, 1000);
    const online = b.peers.filter(p => ![x, p2].includes(p)).concat(newhub);
    await world.until(() => online.every(p => view(b, p).hubs && current(b, p) && view(b, p).members.filter(m => !m.me && m.key !== keyOf(b, x)).every(m => m.online)), 10 * 60_000, 1000);
    const lines = ["while away 1", "while away 2", "while away 3"];
    for (const [i, line] of lines.entries()) { await b.peers[[3, 4, 6][i]].groups.send(b.id, line); await world.run(2_000); }
    for (const p of online) for (const line of lines) expect(world.texts(p, b.id)).toContain(line);
    const took = await back(b, x, lines);
    expect(took).toBeDefined();
    // Within a gossip turn (60 s) after its first edge is up: 1 s or 61 s, by the keys the run drew.
    expect(took!).toBeLessThanOrEqual(2 * 60_000);
  }, 300_000);

  it("C4C (control): no commit, p2 and p5 close, p9 stays a hub: x catches up through p9", async () => {
    const { b, world, x } = await settled([9]);
    const [p2, p5] = [b.peers[2], b.peers[5]];
    x.online = false;
    p2.online = false; p5.online = false;
    const online = b.peers.filter(p => ![x, p2, p5].includes(p));
    await world.run(5 * 60_000);
    const lines = ["while away 1", "while away 2", "while away 3"];
    for (const [i, line] of lines.entries()) { await b.peers[[3, 4, 6][i]].groups.send(b.id, line); await world.run(2_000); }
    for (const p of online) for (const line of lines) expect(world.texts(p, b.id)).toContain(line);
    const took = await back(b, x, lines);
    expect(took).toBeDefined();
    // Within a gossip turn (60 s) after its first edge is up: 1 s or 61 s, by the keys the run drew.
    expect(took!).toBeLessThanOrEqual(2 * 60_000);
  }, 300_000);

  it("C4D (control): a plain join commits, p2 and p5 close, p9 already a hub: x catches up through p9", async () => {
    const { b, world, x } = await settled([9]);
    const [p2, p5] = [b.peers[2], b.peers[5]];
    x.online = false;
    const joiner = await join(b, "joiner", false);
    p2.online = false; p5.online = false;
    const online = b.peers.filter(p => ![x, p2, p5].includes(p)).concat(joiner);
    await world.run(5 * 60_000);
    const lines = ["while away 1", "while away 2", "while away 3"];
    for (const [i, line] of lines.entries()) { await b.peers[[3, 4, 6][i]].groups.send(b.id, line); await world.run(2_000); }
    for (const p of online) for (const line of lines) expect(world.texts(p, b.id)).toContain(line);
    const took = await back(b, x, lines);
    expect(took).toBeDefined();
    // Within a gossip turn (60 s) after its first edge is up: 1 s or 61 s, by the keys the run drew.
    expect(took!).toBeLessThanOrEqual(2 * 60_000);
  }, 300_000);
});
