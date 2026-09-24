import { describe, expect, it } from "vitest";
import { COMMUNITY_TOPOLOGY } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * Load test of `group-community/1` on headless engines (the real `Groups`/`Communities`/
 * `CommunitySession`, no UI, no WebRTC; Pkarr and edges in memory). Not part of `npm test`:
 *
 *   npm run test:group-load            (256 members, the cap)
 *   GROUP_LOAD=64 npm run test:group-load
 *
 * It measures what the profile's member cap rests on: admission of everyone through the link in
 * waves, with the admin gone after the first ones; hub election and edges per peer; delivery of a
 * message from every member to every member, with frames and bytes per message; catch-up of a
 * tenth of the group that was away; a removal re-keying everyone else. Numbers go to stdout as JSON.
 */
const N = Number(process.env.GROUP_LOAD ?? 0);
const WAVE = 16;

describe.runIf(N > 0)(`community group load: ${N} members`, () => {
  it("admits, elects hubs, delivers to everyone, catches up and re-keys at this size", async () => {
    const report: Record<string, unknown> = { members: N };
    const wall = () => performance.now();
    const world = new CommunityWorld();
    const admin = world.add("admin");
    const id = await admin.groups.create("Load");
    const link = await admin.groups.enableLink(id);
    const peers: Peer[] = [admin];

    // Admission through the link, in waves; the admin closes its app after the first wave.
    let t = wall(), simStart = world.now;
    for (let i = 1; i < N; i += WAVE) {
      const wave = Array.from({ length: Math.min(WAVE, N - i) }, (_, j) => world.add(`p${i + j}`));
      for (const p of wave) await p.groups.joinByLink(link);
      await world.until(() => wave.every(p => world.member(p, id)), 15 * 60_000, 1000, () => `wave ${i}: ${wave.filter(p => !world.member(p, id)).map(p => p.name).join(",")}`);
      peers.push(...wave);
      if (i === 1) admin.online = false;
    }
    report.joinSimulatedSeconds = (world.now - simStart) / 1000;
    report.joinWallSeconds = Math.round(wall() - t) / 1000;
    const online = peers.filter(p => p.online);
    // Everyone ends on one roster of N: races while admitting are settled and their losers let in again.
    simStart = world.now;
    await world.until(() => online.every(p => world.view(p, id)?.members.length === N) && new Set(online.map(p => world.view(p, id)?.epoch)).size === 1, 15 * 60_000, 1000,
      () => `converge: ${online.filter(p => world.view(p, id)?.members.length !== N).map(p => `${p.name} ${world.view(p, id)?.status} members=${world.view(p, id)?.members.length} ${JSON.stringify(world.view(p, id)?.community)}`).slice(0, 5).join("; ")}`);
    report.convergeSimulatedSeconds = (world.now - simStart) / 1000;
    report.races = (world.view(admin.online ? admin : online[0], id)?.epoch ?? 0) - (N - 1);

    // Topology.
    const hubs = online.filter(p => p.groups.communities.isHub(id));
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge").length;
    report.hubs = hubs.length;
    report.edgesPerHub = { max: Math.max(...hubs.map(edgesOf)), mean: Math.round(hubs.reduce((s, p) => s + edgesOf(p), 0) / hubs.length) };
    report.edgesPerMember = { max: Math.max(...online.filter(p => !hubs.includes(p)).map(edgesOf)) };
    expect(hubs.length).toBeLessThanOrEqual(COMMUNITY_TOPOLOGY.maxHubs);

    // Everyone says something; everyone reads everyone.
    const frames0 = online.reduce((s, p) => s + p.sent.frames, 0), bytes0 = online.reduce((s, p) => s + p.sent.bytes, 0);
    t = wall();
    for (const p of online) await p.groups.send(id, `hello from ${p.name}`);
    await world.run(10_000);
    report.messageWallMsPerMessage = Math.round((wall() - t) / online.length);
    const frames = online.reduce((s, p) => s + p.sent.frames, 0) - frames0, bytes = online.reduce((s, p) => s + p.sent.bytes, 0) - bytes0;
    report.framesPerMessage = Math.round(frames / online.length);
    report.bytesPerMessage = Math.round(bytes / online.length);
    const missing = online.map(p => online.length - new Set(world.texts(p, id).filter(x => x.startsWith("hello from "))).size);
    report.undelivered = missing.reduce((a, b) => a + b, 0);
    expect(report.undelivered).toBe(0);

    // A tenth goes away, the rest keep talking; back, they are caught up by whoever is there.
    const away = online.filter(p => !hubs.includes(p)).slice(0, Math.max(1, Math.floor(N / 10)));
    for (const p of away) p.online = false;
    const talking = online.filter(p => p.online).slice(0, 20);
    for (const p of talking) await p.groups.send(id, `while away ${p.name}`);
    await world.run(5_000);
    for (const p of away) p.online = true;
    simStart = world.now;
    await world.until(() => away.every(p => talking.every(q => world.texts(p, id).includes(`while away ${q.name}`))), 5 * 60_000, 1000,
      () => `catch-up: ${away.filter(p => !talking.every(q => world.texts(p, id).includes(`while away ${q.name}`))).map(p => `${p.name} has ${talking.filter(q => world.texts(p, id).includes(`while away ${q.name}`)).length}/${talking.length} ${JSON.stringify(world.view(p, id)?.community)}`).slice(0, 5).join("; ")}`);
    report.catchUpSimulatedSeconds = (world.now - simStart) / 1000;

    // The admin returns and removes someone: a fresh secret sealed to everyone else, relayed by the hubs.
    admin.online = true;
    await world.run(30_000);
    const gone = online.find(p => !hubs.includes(p) && !away.includes(p))!;
    const goneKey = world.view(gone, id)!.myKey!;
    t = wall(); simStart = world.now;
    await admin.groups.remove(id, goneKey);
    const everyoneElse = peers.filter(p => p !== gone);
    await world.until(() => everyoneElse.every(p => world.view(p, id)?.members.length === N - 1 && world.view(p, id)?.canSend), 5 * 60_000, 1000,
      () => `removal: ${everyoneElse.filter(p => !(world.view(p, id)?.members.length === N - 1 && world.view(p, id)?.canSend)).map(p => `${p.name} members=${world.view(p, id)?.members.length} epoch=${world.view(p, id)?.epoch} status=${world.view(p, id)?.status} canSend=${world.view(p, id)?.canSend} ${JSON.stringify(world.view(p, id)?.community)}`).slice(0, 5).join("; ")}`);
    report.removalSimulatedSeconds = (world.now - simStart) / 1000;
    report.removalWallSeconds = Math.round(wall() - t) / 1000;
    const speaker = everyoneElse[everyoneElse.length - 1];
    await speaker.groups.send(id, "after the removal");
    await world.run(10_000);
    expect(everyoneElse.every(p => world.texts(p, id).includes("after the removal"))).toBe(true);
    expect(world.texts(gone, id)).not.toContain("after the removal");

    report.pkarrOperations = world.pkarrOps;
    report.heapMiB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`GROUP_LOAD_REPORT ${JSON.stringify(report)}`);
  }, 60 * 60_000);
});
