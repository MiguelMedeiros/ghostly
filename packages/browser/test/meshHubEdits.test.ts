import { afterEach, describe, expect, it } from "vitest";
import { REMOVED_TEXT } from "@ghostly/core";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.protocol.edits

/**
 * Edits on hubs (WISP 902 · Group Mesh § Edits, § Hubs), on headless engines (the real `Groups`, `MeshHubs` and
 * `GroupSession`; Pkarr and links in memory, simulated clock). Hubs change: the ones a group had when a message was
 * written leave or close, and newcomers whose apps stay online carry it from then on. They were not in the message's
 * epoch, so they cannot read its edits; they carry them all the same.
 */

const edits = new Map<Peer, { id: string; e: number; m: string; rm?: true }[]>();

describe("edits in a private group on hubs", () => {
  it("an edit and a removal of a message older than the current hubs reach every member through them", async () => {
    const world = new CommunityWorld();
    const hooks = (p: Peer) => ({ groupEdit: (_g: string, e: { id: string; e: number; m: string; rm?: true }) => { edits.set(p, [...edits.get(p) ?? [], e]); } });
    const add = (name: string, staysOnline = false) => world.add(name, hooks, { staysOnline });
    const admin = add("admin");
    const id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers = [admin];
    const join = async (p: Peer) => { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000, 500); peers.push(p); };
    for (let i = 1; i < 20; i++) await join(add(`p${i}`, i === 2 || i === 5));
    const view = (p: Peer) => world.view(p, id)!;
    await world.until(() => peers.every(p => !!view(p).hubs && view(p).members.every(m => m.online)), 10 * 60_000, 1000);
    await world.run(150_000);

    const author = peers[3];
    const kept = (await author.groups.send(id, "keep A")).messageId!;
    const gone = (await author.groups.send(id, "del B")).messageId!;
    await world.until(() => peers.every(p => world.texts(p, id).includes("del B")), 60_000, 1000);

    // The hubs change: one leaves, the other's app closes, and two newcomers that stay online carry the group.
    const old = [peers[2], peers[5]];
    await old[0].groups.leave(id);
    old[1].online = false;
    const hubA = add("hubA", true), hubB = add("hubB", true);
    await join(hubA); await join(hubB);
    const newKeys = [hubA, hubB].map(p => view(p).myKey!);
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id).map(e => e.peer);
    await world.until(() => edgesOf(author).length > 0 && edgesOf(author).every(k => newKeys.includes(k)), 10 * 60_000, 1000,
      () => `author's edges: ${edgesOf(author).map(k => peers.find(p => view(p)?.myKey === k)?.name).join(",")}`);

    expect(await author.groups.sendEdit(id, { id: kept, e: 1, ts: world.now, m: "A edited" })).toBeNull();
    expect(await author.groups.sendEdit(id, { id: gone, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true })).toBeNull();
    // Every member of the message's epoch still in the group, none of them on an edge with the author.
    const readers = peers.filter(p => p !== author && !old.includes(p) && p !== hubA && p !== hubB);
    // (Twice each, once per hub: the app shows an edit no newer than its text once.)
    const took = (p: Peer) => [kept, gone].every(m => (edits.get(p) ?? []).some(e => e.id === m));
    await world.until(() => readers.every(took), 30_000, 1000, () => `took both: ${readers.filter(took).length}/${readers.length}`);
    for (const p of readers) expect(edits.get(p)!.find(e => e.id === kept)).toMatchObject({ e: 1, m: "A edited" });
    for (const p of readers) expect(edits.get(p)!.find(e => e.id === gone)).toMatchObject({ rm: true });
    // The newcomers carried them, unread.
    for (const p of [hubA, hubB]) expect(edits.get(p) ?? []).toEqual([]);
  }, 300_000);
});

describe("a member back on hubs that changed twice since an edit", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  // The hub that carried the edit left; the one let in after it is the member's only edge: it was handed the edit
  // unread by the members that hold it, once each, and hands it on at the member's catch-up.
  it.each([11, 22, 33])("gets the edit and the removal from a hub let in after them (seed %i)", async seed => {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const got = new Map<Peer, { id: string; e: number; m: string; rm?: true }[]>();
    const hooks = (p: Peer) => ({ groupEdit: (_g: string, e: { id: string; e: number; m: string; rm?: true }) => { got.set(p, [...got.get(p) ?? [], e]); } });
    const add = (name: string, staysOnline = false) => world.add(name, hooks, { staysOnline });
    const admin = add("admin");
    const id = await admin.groups.create("Hubs", "mesh");
    const link = await admin.groups.enableLink(id);
    const peers = [admin];
    const join = async (p: Peer) => { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000, 500); peers.push(p); };
    for (let i = 1; i < 20; i++) await join(add(`p${i}`, i === 2 || i === 5));
    const view = (p: Peer) => world.view(p, id)!;
    await world.until(() => peers.every(p => !!view(p).hubs && view(p).members.every(m => m.online)), 10 * 60_000, 1000);
    await world.run(150_000);

    const [x, author] = [peers[1], peers[3]];
    const kept = (await author.groups.send(id, "keep A")).messageId!;
    const gone = (await author.groups.send(id, "del B")).messageId!;
    await world.until(() => peers.every(p => world.texts(p, id).includes("del B")), 60_000, 1000);
    x.online = false;

    // The hubs change once: one leaves, the other's app closes, and a newcomer that stays online is the hub.
    await peers[2].groups.leave(id);
    peers[5].online = false;
    const hubA = add("hubA", true);
    await join(hubA);
    const keyOf = (p: Peer) => view(p).myKey!;
    const edgeUp = (p: Peer, to: Peer) => view(p).members.some(m => m.key === keyOf(to) && m.online && !m.viaHub);
    const settledOn = (hub: Peer) => peers.filter(p => p.online && p !== hub && p !== peers[2] && !(hub !== hubA && p === hubA)).every(p => edgeUp(p, hub));
    await world.until(() => view(hubA).hubs?.hub === true && settledOn(hubA), 10 * 60_000, 1000);
    await world.run(60_000);
    expect(await author.groups.sendEdit(id, { id: kept, e: 1, ts: world.now, m: "A edited" })).toBeNull();
    expect(await author.groups.sendEdit(id, { id: gone, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true })).toBeNull();
    const readers = peers.filter(p => ![x, author, peers[2], peers[5], hubA].includes(p));
    const took = (p: Peer) => [kept, gone].every(m => (got.get(p) ?? []).some(e => e.id === m));
    await world.until(() => readers.every(took), 30_000, 1000, () => `took both: ${readers.filter(took).length}/${readers.length}`);
    author.online = false;

    // And again: that hub leaves, and a newcomer let in after the edits is the hub.
    await hubA.groups.leave(id);
    const hubB = add("hubB", true);
    // Every edit frame each member hands the new hub, from now on.
    const handed = new Map<string, number>();
    world.drop = (from, to, frame) => {
      if (frame.t === "group-edit" && to === hubB) handed.set(from.name, (handed.get(from.name) ?? 0) + 1);
      return false;
    };
    await join(hubB);
    await world.until(() => view(hubB).hubs?.hub === true && settledOn(hubB), 10 * 60_000, 1000);
    await world.run(180_000);
    // Bounded: each member hands the new hub each edit it keeps once at most (two here), however often it is asked.
    expect([...handed.values()].every(n => n <= 2)).toBe(true);
    expect(handed.size).toBeGreaterThan(0);

    // x comes back, the author's app closed. The members standing in for it bring it the chain (whose beacon names the
    // new hub), but hand it no edit, as when they were away too: only the new hub can, from its catch-up.
    world.drop = (from, to, frame) => frame.t === "group-edit" && to === x && from !== hubB;
    world.reopen(x);
    // Its first ask for the author goes to whichever edge is up first (a stand-in here); the hub is asked at the next
    // gossip turn (`MESH_GOSSIP_MS`) at the latest.
    await world.until(() => took(x), 90_000, 1000, () => `x took ${JSON.stringify(got.get(x) ?? [])}; edges ${view(x).members.filter(m => !m.me && m.online && !m.viaHub).map(m => peers.find(p => world.view(p, id)?.myKey === m.key)?.name)}`);
    expect(got.get(x)!.find(e => e.id === kept)).toMatchObject({ e: 1, m: "A edited" });
    expect(got.get(x)!.find(e => e.id === gone)).toMatchObject({ rm: true });
    // The newcomers carried them, unread.
    for (const p of [hubA, hubB]) expect(got.get(p) ?? []).toEqual([]);
  }, 300_000);
});
