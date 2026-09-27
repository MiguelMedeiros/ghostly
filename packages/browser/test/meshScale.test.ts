import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUP_LIMITS, GROUP_MEMBER_CAP, MAX_GROUP_MEMBERS, MESH_HUBS } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type NetworkModel, type Peer } from "./communityWorld";
// covers: groups.link.join, groups.send, groups.catch-up, groups.remove-member

/**
 * A private (mesh) group past eight members on headless engines (the real `Groups` and `GroupSession`, no UI, no
 * WebRTC; Pkarr and links in memory, simulated clock), the harness the community load test uses. What it checks:
 * everyone joins through the admin's link, a message reaches every member, a member who was away gets what an author
 * sent while the author is gone too (from a third member, WISP 9xx § Catch-up), and someone removed gets nothing
 * after. With `RELAY_NETWORK`, links cost what they cost on public relays, and the report says what a member spends.
 *
 * In `npm test`: 20 members, the network free. Measured, for the PR and the WISP:
 *
 *   MESH_SCALE=8,16,32 MESH_SCALE_OUT=/tmp/mesh.jsonl npx vitest run packages/browser/test/meshScale.test.ts
 *
 * With hubs (WISP 9xx · Group Mesh § Hubs): `MESH_HUBS=2` makes the first two members after the admin apps that stay
 * online (the Desktop app or the CLI; their Pkarr requests are counted, not held to the relays' budget, since they read
 * the DHT). `MESH_HUBS=0,2` measures both. Past 32 (`MESH_SCALE=64,128`) the harness raises the member cap: what hubs
 * would cost, not what the apps allow.
 */

interface Report { members: number; network: string; [key: string]: unknown }

/**
 * `burst`: newcomers open the link four at a time (the admin runs four entry sessions at once), a stress case; else one
 * after another, as bots are added to a group. A burst that does not get in within ten minutes is counted, not failed.
 */
async function scale(n: number, network: NetworkModel | null, burst = false, hubCount = 0): Promise<Report> {
  const report: Report = { members: n, network: network ? "relays" : "free", joins: burst ? "four at a time" : "one at a time", hubs: hubCount };
  const wall = () => performance.now();
  const world = new CommunityWorld(undefined, network);
  const admin = world.add("admin");
  const app = (i: number) => (i >= 1 && i <= hubCount ? { staysOnline: true, unmetered: true } : {});
  const isHub = (p: Peer) => !!p.staysOnline && hubCount > 0 && n > MESH_HUBS.threshold;
  const id = await admin.groups.create("Scale", "mesh");
  const link = await admin.groups.enableLink(id);
  const peers: Peer[] = [admin];
  const view = (p: Peer) => world.view(p, id);
  const keyOf = (p: Peer) => view(p)!.myKey!;

  // Joins through the link.
  let simStart = world.now, t = wall();
  const joinTimes: number[] = [];
  let stalled = 0;
  const size = burst ? 4 : 1;
  for (let i = 1; i < n; i += size) {
    const wave = Array.from({ length: Math.min(size, n - i) }, (_, j) => world.add(`p${i + j}`, undefined, app(i + j)));
    const started = world.now;
    for (const p of wave) await p.groups.joinByLink(link);
    const joined = new Map<Peer, number>();
    const done = () => { for (const p of wave) if (!joined.has(p) && world.member(p, id)) joined.set(p, world.now - started); return joined.size === wave.length; };
    try { await world.until(done, 10 * 60_000, 500); } catch (error) {
      if (!burst) throw error;
      // Counted, and let in by a second knock: what a person does after a while.
      stalled += wave.length - joined.size;
      await world.until(done, 30 * 60_000, 1000);
    }
    joinTimes.push(...joined.values());
    peers.push(...wave);
  }
  if (burst) report.joinsOverTenMinutes = stalled;
  report.joinSimulatedSeconds = (world.now - simStart) / 1000;
  joinTimes.sort((a, b) => a - b);
  report.joinEachSeconds = { p50: joinTimes[Math.floor(joinTimes.length / 2)] / 1000, max: joinTimes[joinTimes.length - 1] / 1000 };
  report.joinWallSeconds = Math.round(wall() - t) / 1000;

  // Every member sees every other online: the full mesh, n(n-1)/2 edges.
  simStart = world.now;
  const allUp = () => peers.every(p => view(p)?.members.length === n && view(p)!.members.every(m => m.online));
  await world.until(allUp, 15 * 60_000, 1000, () => peers.filter(p => !view(p)?.members.every(m => m.online)).slice(0, 3)
    .map(p => `${p.name} ${view(p)?.members.filter(m => m.online).length}/${view(p)?.members.length}`).join("; "));
  report.meshUpSimulatedSeconds = (world.now - simStart) / 1000;
  const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).length;
  const hubbed = hubCount > 0 && n > MESH_HUBS.threshold;
  // With hubs, the edges a member no longer needs close once it picked its hubs.
  if (hubbed) await world.until(() => peers.filter(p => !isHub(p)).every(p => edgesOf(p) <= MESH_HUBS.hubsPerMember), 10 * 60_000, 1000,
    () => peers.filter(p => !isHub(p) && edgesOf(p) > MESH_HUBS.hubsPerMember).slice(0, 3).map(p => `${p.name} ${edgesOf(p)}`).join("; "));
  report.edgesPerMember = Math.max(...peers.filter(p => !isHub(p)).map(edgesOf));
  if (hubbed) report.edgesPerHub = Math.max(...peers.filter(isHub).map(edgesOf));
  expect(report.edgesPerMember).toBe(hubbed ? MESH_HUBS.hubsPerMember : n - 1);

  // Steady state, quiet minutes once joins are over: what a member spends on Pkarr to keep its edges up.
  if (network) {
    await world.run(5 * 60_000);
    const spent = new Map<Peer, number>();
    world.onSpend = (p, _what, cost, ok) => { if (ok) spent.set(p, (spent.get(p) ?? 0) + cost); };
    await world.run(4 * 60_000);
    world.onSpend = null;
    const per = (p: Peer) => (spent.get(p) ?? 0) / 4;
    const members = peers.slice(1).filter(p => !isHub(p)).map(per).sort((a, b) => a - b);
    // Each edge also republishes its presence every 4 min (not in the model): a PUT to both relays, 2 requests.
    const edges = (p: Peer) => edgesOf(p);
    report.pkarrPerMemberPerMinute = { median: members[Math.floor(members.length / 2)], max: members[members.length - 1], admin: per(admin),
      heartbeats: Math.round(Math.max(...peers.filter(p => !isHub(p)).map(edges)) * 2 / 4 * 10) / 10, budget: 60,
      ...(hubbed ? { hub: Math.max(...peers.filter(isHub).map(per)), hubHeartbeats: Math.round(Math.max(...peers.filter(isHub).map(edges)) * 2 / 4 * 10) / 10 } : {}) };
  }

  // Fan-out: everyone says something, everyone reads everyone.
  const frames0 = peers.reduce((s, p) => s + p.sent.frames, 0), bytes0 = peers.reduce((s, p) => s + p.sent.bytes, 0);
  // What one member's message costs its author (the rest is what hubs pass on), measured on a member that is no hub.
  const writer = peers[n - 3], writerFrames0 = writer.sent.frames, writerBytes0 = writer.sent.bytes;
  const hubFrames0 = peers.filter(isHub).map(p => p.sent.frames);
  await writer.groups.send(id, "one message");
  await world.run(2_000);
  report.authorPerMessage = { frames: writer.sent.frames - writerFrames0, bytes: writer.sent.bytes - writerBytes0 };
  if (hubbed) report.hubFramesPerMessage = Math.max(...peers.filter(isHub).map((p, i) => p.sent.frames - hubFrames0[i]));
  const frames1 = peers.reduce((s, p) => s + p.sent.frames, 0) - frames0;
  report.networkFramesPerMessage = frames1;
  for (const p of peers) expect(world.texts(p, id)).toContain("one message");
  const fanFrames0 = peers.reduce((s, p) => s + p.sent.frames, 0), fanBytes0 = peers.reduce((s, p) => s + p.sent.bytes, 0);
  t = wall();
  for (const p of peers) await p.groups.send(id, `hello from ${p.name}`);
  await world.run(2_000);
  report.sendWallMsPerMessage = Math.round((wall() - t) / n * 10) / 10;
  const frames = peers.reduce((s, p) => s + p.sent.frames, 0) - fanFrames0, bytes = peers.reduce((s, p) => s + p.sent.bytes, 0) - fanBytes0;
  report.framesPerMessage = Math.round(frames / n);
  report.bytesPerMessage = Math.round(bytes / n);
  for (const p of peers) expect(new Set(world.texts(p, id).filter(x => x.startsWith("hello from "))).size).toBe(n);

  // Away: one member closes its app for a while; an author posts, then closes its app too. Back, the member gets it from
  // whoever is there, and its edges come up again.
  const [absent, author] = [peers[n - 1], peers[n - 2]];
  absent.online = false;
  await world.run(3 * 60_000);
  for (let i = 0; i < 3; i++) await author.groups.send(id, `status ${i} from ${author.name}`);
  await world.run(2_000);
  author.online = false;
  await world.run(5_000);
  let handedOn = 0;
  world.drop = (_from, to, frame) => { if (to === absent && frame.t === "group-msg") handedOn++; return false; };
  world.reopen(absent);
  simStart = world.now;
  const caught = () => [0, 1, 2].every(i => world.texts(absent, id).includes(`status ${i} from ${author.name}`));
  await world.until(caught, 10 * 60_000, 500, () => `catch-up: ${world.texts(absent, id).filter(x => x.startsWith("status")).length}/3`);
  report.catchUpFromOthersSimulatedSeconds = (world.now - simStart) / 1000;
  // Every member reachable again: over an edge, or through a hub.
  const backUp = () => view(absent)!.members.filter(m => !m.me && m.key !== keyOf(author)).every(m => m.online);
  await world.until(backUp, 15 * 60_000, 1000, () => `back: ${view(absent)!.members.filter(m => m.online).length}/${n}`);
  report.returnAllEdgesUpSimulatedSeconds = (world.now - simStart) / 1000;
  // Each missed message about once, not once per member (`ask` goes to one member at a time).
  report.messagesToReturningMember = { missed: 3, frames: handedOn };
  world.drop = null;
  world.reopen(author);
  await world.run(60_000);

  // What a member keeps to hand on, and what saving the group costs per message it takes.
  const stored = (await admin.store.getGroups()).find(g => g.id === id)!;
  report.stateKiB = Math.round(JSON.stringify(stored).length / 1024);
  report.relayLogFrames = stored.state?.relay?.length ?? 0;
  const clones = 50;
  t = wall();
  for (let i = 0; i < clones; i++) JSON.stringify(structuredClone(stored));
  report.saveCloneMs = Math.round((wall() - t) / clones * 100) / 100;

  // Removal: the admin removes a member; everyone else moves on, the removed one reads nothing after.
  const gone = peers[hubCount + 1], goneKey = keyOf(gone);
  simStart = world.now;
  await admin.groups.remove(id, goneKey);
  const others = peers.filter(p => p !== gone);
  await world.until(() => others.every(p => view(p)?.members.length === n - 1 && view(p)?.canSend), 5 * 60_000, 500);
  report.removalSimulatedSeconds = (world.now - simStart) / 1000;
  await others[others.length - 1].groups.send(id, "after the removal");
  simStart = world.now;
  // Straight from the author where its edge is up; through a member where it is not yet (the gossip turn, 60 s).
  await world.until(() => others.every(p => world.texts(p, id).includes("after the removal")), 5 * 60_000, 500,
    () => `after removal: ${others.filter(p => !world.texts(p, id).includes("after the removal")).length} missing`);
  report.deliveredAfterRemovalSimulatedSeconds = (world.now - simStart) / 1000;
  await world.run(5_000);
  expect(world.texts(gone, id)).not.toContain("after the removal");
  // Nobody hands on what the removed member sent.
  for (const p of others) {
    const state = (await p.store.getGroups()).find(g => g.id === id)?.state;
    expect(state?.relay?.some(f => f.s === goneKey) ?? false).toBe(false);
  }

  report.pkarrOperations = world.pkarrOps;
  report.heapMiB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  report.relayLogBound = { frames: GROUP_LIMITS.relay, KiB: GROUP_LIMITS.relayBytes / 1024 };
  return report;
}

const SIZES = (process.env.MESH_SCALE ?? "").split(",").map(Number).filter(n => n > 1);
const HUBS = (process.env.MESH_HUBS ?? "0").split(",").map(Number).filter(n => n >= 0);
/** Which runs: `MESH_RUNS=free,relays,bursts` (all three by default). */
const RUNS = (process.env.MESH_RUNS ?? "free,relays,bursts").split(",");

describe("a private group of twenty on headless engines", () => {
  it("joins by the link, delivers to all, catches up from a third member, and excludes the removed", async () => {
    const report = await scale(20, null);
    expect(report.edgesPerMember).toBe(19);
  }, 120_000);
});

describe("a private group of twenty with two hubs", () => {
  it("members keep two edges, and everything else holds", async () => {
    const report = await scale(20, null, false, 2);
    expect(report.edgesPerMember).toBe(2);
    expect(report.authorPerMessage).toMatchObject({ frames: 2 });
  }, 120_000);
});

describe.runIf(SIZES.length > 0)("private group scale, measured", () => {
  const runs = ([["free", null, false], ["relays", RELAY_NETWORK, false], ["bursts", RELAY_NETWORK, true]] as const).filter(([name]) => RUNS.includes(name));
  for (const n of SIZES) for (const hubs of HUBS) for (const [, network, burst] of runs) it(`${n} members, ${hubs} hubs, network ${network ? "relays" : "free"}${burst ? ", joins in bursts" : ""}`, async () => {
    // Past 32, a measurement of what hubs would cost: the apps keep the cap.
    GROUP_MEMBER_CAP.max = Math.max(MAX_GROUP_MEMBERS, n);
    let report: Report;
    try { report = await scale(n, network, burst, hubs); } finally { GROUP_MEMBER_CAP.max = MAX_GROUP_MEMBERS; }
    console.log(`MESH_SCALE_REPORT ${JSON.stringify(report)}`);
    if (process.env.MESH_SCALE_OUT) appendFileSync(process.env.MESH_SCALE_OUT, JSON.stringify(report) + "\n");
  }, 30 * 60_000);
});
