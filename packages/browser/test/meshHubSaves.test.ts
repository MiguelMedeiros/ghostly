import { afterEach, describe, expect, it } from "vitest";
import type { GroupSession } from "@ghostly/core";
import { Groups, type GroupStore } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.hubs

/**
 * What a private group on hubs writes when its hubs come and go (WISP 902 · Group Mesh § Hubs). The hub list a member
 * keeps for its next start (`StoredGroup.hubs`, at most eight keys) wrote the group's whole record, membership chain
 * included, every time it changed: two hubs away 90 s every 2 minutes cost every other hub 30 whole writes (1.7 MB) in
 * 30 min in a group of 31, and a hub closing cost each member it carried its record once or twice. The real
 * `Groups`, `MeshHubs` and `GroupSession` on headless engines, Pkarr and links in memory, simulated clock.
 */

interface Built { world: CommunityWorld; id: string; admin: Peer; peers: Peer[] }
/** Per peer: whole writes of the record (`putGroup`) and characters written to each kind of row. */
interface Writes { whole: number; bytes: { whole: number; live: number; light: number } }

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

const HUBS = [0, 2, 5, 9, 14, 20];

async function build(n: number, seed: number): Promise<Built> {
  const world = new CommunityWorld(undefined, null, seededRandom(seed));
  restore = sameRun(world, seed);
  const admin = world.add("admin", undefined, { staysOnline: HUBS.includes(0) });
  const id = await admin.groups.create("Hubs", "mesh");
  const link = await admin.groups.enableLink(id);
  const peers = [admin];
  for (let i = 1; i < n; i++) {
    const p = world.add(`p${i}`, undefined, { staysOnline: HUBS.includes(i) });
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000, 500);
    peers.push(p);
  }
  const b = { world, id, admin, peers };
  await world.until(() => peers.every(p => !!view(b, p).hubs) && peers.every(p => view(b, p).members.every(m => m.online)), 10 * 60_000, 1000);
  await world.run(150_000);
  return b;
}

const view = (b: Built, p: Peer) => b.world.view(p, b.id)!;
const keyOf = (b: Built, p: Peer) => view(b, p).myKey!;
const engineOf = (p: Peer) => p.groups as unknown as { stored: Map<string, StoredGroup>; sessions: Map<string, GroupSession>; hubs: { wanted(id: string, s: GroupSession, g: StoredGroup, now: number): Set<string> | null } };
const storedHubs = (b: Built, p: Peer) => engineOf(p).stored.get(b.id)?.hubs ?? [];

/** Counts what each peer's store is asked to write from now on. */
function count(peers: Peer[]): Map<Peer, Writes> {
  const out = new Map<Peer, Writes>();
  for (const p of peers) {
    const w: Writes = { whole: 0, bytes: { whole: 0, live: 0, light: 0 } };
    out.set(p, w);
    const s = p.store as Required<GroupStore>, { putGroup, putGroupLive, putGroupLight } = s;
    s.putGroup = (group, live) => { w.whole++; w.bytes.whole += JSON.stringify(group).length + (live ? JSON.stringify(live).length : 0); return putGroup(group, live); };
    s.putGroupLive = (id, row) => { w.bytes.live += JSON.stringify(row).length; return putGroupLive(id, row); };
    s.putGroupLight = (id, row) => { w.bytes.light += JSON.stringify(row).length; return putGroupLight(id, row); };
  }
  return out;
}
const total = (w: Writes) => w.bytes.whole + w.bytes.live + w.bytes.light;

describe("a private group's hub list, saved", () => {
  it("5 members (2 of them hubs) offline and back every 2 minutes for 30 min: the steady hubs write no whole record for it", async () => {
    const b = await build(31, 3);
    const { world, peers } = b;
    const flapping = [5, 9, 4, 6, 13].map(i => peers[i]), steady = [0, 2, 14, 20].map(i => peers[i]);
    const changes = new Map(steady.map(p => [p, 0])), seen = new Map<Peer, string>();
    /** Away 90 s (a hub's entry is stale after 90 s), back 30 s, `cycles` times; the steady hubs' lists looked at every 10 s. */
    const flap = async (cycles: number) => {
      for (let t = 0; t < cycles * 120_000; t += 10_000) {
        if (t % 120_000 === 0) for (const p of flapping) p.online = false;
        if (t % 120_000 === 90_000) for (const p of flapping) world.reopen(p);
        await world.run(10_000);
        for (const p of steady) { const now = storedHubs(b, p).join(); if (seen.has(p) && seen.get(p) !== now) changes.set(p, changes.get(p)! + 1); seen.set(p, now); }
      }
    };
    for (const p of peers) await p.groups.flush();
    const writes = count(peers);
    await flap(15);
    for (const p of peers) await p.groups.flush();
    const report = steady.map(p => `${p.name}: ${changes.get(p)} list changes, ${writes.get(p)!.whole} whole, ${JSON.stringify(writes.get(p)!.bytes)}`).join("; ");
    // The hub lists did change (each steady hub's other hubs went and came back), so there was something to save.
    for (const p of steady) expect(changes.get(p), report).toBeGreaterThanOrEqual(15);
    // Before: a whole record (about 58 KB here) at each change, 30 in all.
    for (const p of steady) expect(writes.get(p)!.whole, report).toBeLessThanOrEqual(1);
    for (const p of steady) expect(total(writes.get(p)!), report).toBeLessThan(100_000);
    // The lists were saved, in their small row.
    for (const p of steady) expect(writes.get(p)!.bytes.light, report).toBeGreaterThan(0);
  }, 600_000);

  it("a hub that carries members closes: each member it carried saves its new hubs in under 1 KB, and starts on them again", async () => {
    const b = await build(31, 5);
    const { world, peers, id } = b;
    const hubs = HUBS.map(i => peers[i]);
    const carried = (h: Peer) => peers.filter(p => !hubs.includes(p) && storedHubs(b, p).includes(keyOf(b, h)));
    /** The hub most members count on. */
    const busiest = () => hubs.filter(h => h.online).reduce((a, c) => carried(c).length > carried(a).length ? c : a);
    const moved = (ps: Peer[], h: Peer) => () => ps.every(p => !storedHubs(b, p).includes(keyOf(b, h)) && storedHubs(b, p).length > 0);
    const hub = busiest(), theirs = carried(hub);
    expect(theirs.length).toBeGreaterThan(2);
    for (const p of peers) await p.groups.flush();
    const writes = count(theirs);
    hub.online = false;
    await world.until(moved(theirs, hub), 5 * 60_000, 1000);
    await world.run(60_000);
    for (const p of theirs) await p.groups.flush();
    const report = theirs.map(p => `${p.name}: ${writes.get(p)!.whole} whole, ${JSON.stringify(writes.get(p)!.bytes)}`).join("; ");
    // Before: every one of them wrote its whole record (57 KB here, 160 KB after 20 joins and leaves) once or twice: for
    // its new hubs, and for noting the app of a hub it never had an edge with (`StoredGroup.large`).
    for (const p of theirs) expect(writes.get(p)!.whole, report).toBe(0);
    for (const p of theirs) expect(total(writes.get(p)!), report).toBeLessThan(1_000);

    // A member it carried restarts: the hubs it saved last are where its edges go before it reads the beacon.
    const m = theirs[0], saved = [...storedHubs(b, m)];
    expect(saved).not.toContain(keyOf(b, hub));
    // The beacon cannot be read: what it uses is what it saved.
    world.failRead = p => p === m;
    await world.restart(m);
    const g = engineOf(m);
    expect(g.stored.get(id)!.hubs).toEqual(saved);
    const wanted = g.hubs.wanted(id, g.sessions.get(id)!, g.stored.get(id)!, world.now);
    for (const key of saved) expect(wanted).toContain(key);
    expect(wanted).not.toContain(keyOf(b, hub));
    world.failRead = null;

    // An app from before reads the record alone (no small rows): it loads the group, with the hubs its record last held.
    const before: GroupStore = { getGroups: () => m.store.getGroups(), putGroup: group => m.store.putGroup(group), deleteGroup: groupId => m.store.deleteGroup(groupId), getMessages: linkId => m.store.getMessages(linkId) };
    const old = new Groups(m.host, before);
    await old.load();
    expect(world.view({ groups: old } as Peer, id)?.status).toBe("active");
    const record = (await m.store.getGroups()).find(r => r.id === id)!;
    expect(record.hubs?.length).toBeGreaterThan(0);
    // What it started on came from the group's small row: the record still holds the list from before the hub closed.
    expect(record.hubs).toContain(keyOf(b, hub));
    expect((old as unknown as { stored: Map<string, StoredGroup> }).stored.get(id)!.hubs).toEqual(record.hubs);
  }, 600_000);
});
