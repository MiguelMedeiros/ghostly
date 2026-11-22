import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.hubs

/**
 * Lines said while no hub is up, on headless engines (the real `Groups`, `MeshHubs` and `GroupSession`; Pkarr and links
 * in memory, simulated clock). One hub leaves, the other's app closes, three members write anyway, and a newcomer whose
 * app stays online becomes the hub. It was not in the lines' epoch, so it cannot read them; it carries them all the same
 * (WISP 902 § Catch-up, "Carried unread"), and the members it is the only edge of get them without the old hub.
 */

describe("lines said while no hub is up, on hubs", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it.each([11, 22, 33])("reach every member once a newcomer is the hub (seed %i)", async seed => {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const add = (name: string, staysOnline = false) => world.add(name, undefined, { staysOnline });
    const admin = add("admin");
    const id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers = [admin];
    const join = async (p: Peer) => { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000, 500); peers.push(p); };
    for (let i = 1; i < 20; i++) await join(add(`p${i}`, i === 2 || i === 5));
    const view = (p: Peer) => world.view(p, id)!;
    await world.until(() => peers.every(p => !!view(p).hubs && view(p).members.every(m => m.online)), 10 * 60_000, 1000);
    await world.run(150_000);

    const authors = [peers[3], peers[9], peers[12]];
    let n = 0;
    const write = async () => { for (const a of authors) await a.groups.send(id, `m${++n}`); };
    await write();
    // One hub leaves; the other's app closes, and nobody is a hub for a while.
    await peers[2].groups.leave(id);
    await world.run(30_000);
    await write();
    await world.run(30_000);
    peers[5].online = false;
    await world.run(30_000);
    await write();
    // A newcomer whose app stays online steps up.
    const hubA = add("hubA", true);
    await join(hubA);
    await write();

    const readers = peers.filter(p => p !== peers[2] && p !== peers[5] && p !== hubA);
    const lacks = (p: Peer) => { const texts = world.texts(p, id); return Array.from({ length: n }, (_, i) => `m${i + 1}`).filter(m => !texts.includes(m)); };
    const report = () => JSON.stringify(readers.filter(p => lacks(p).length).map(p => ({ p: p.name, miss: lacks(p) })));
    await world.until(() => readers.every(p => !lacks(p).length), 10 * 60_000, 1000, report);
    expect(report()).toBe("[]");
    // The newcomer carried them, unread: it shows only what was said after it was let in.
    expect(world.texts(hubA, id).filter(t => /^m\d+$/.test(t)).sort()).toEqual(["m10", "m11", "m12"]);
  }, 600_000);
});
