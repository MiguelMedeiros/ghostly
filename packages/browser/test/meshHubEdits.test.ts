import { afterEach, describe, expect, it } from "vitest";
import { REMOVED_TEXT } from "@ghostly/core";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.protocol.edits

/**
 * Edits on hubs (WISP 902 · Group Mesh § Edits, § Hubs), on headless engines (the real `Groups`, `MeshHubs` and
 * `GroupSession`; Pkarr and links in memory, simulated clock). Hubs change: the ones a group had when a message was
 * written leave or close, and newcomers whose apps stay online carry it from then on. They were not in the message's
 * epoch, so they cannot read its edits; they carry them all the same.
 *
 * Each run is the same (`sameRun`). With random keys and waits, the other members were sometimes still moving to the
 * newcomers when the author spoke, and took the edits from a newcomer's catch-up ~105 s later: past a 30 s wait, a
 * run in five failed. The wait covers that catch-up (seeds 1 to 30 all pass).
 */

const edits = new Map<Peer, { id: string; e: number; m: string; rm?: true }[]>();

describe("edits in a private group on hubs", () => {
  let restore = () => {};
  afterEach(() => { restore(); restore = () => {}; });

  it("an edit and a removal of a message older than the current hubs reach every member through them", async () => {
    const world = new CommunityWorld(undefined, null, seededRandom(1));
    restore = sameRun(world, 1);
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
    // Edges with apps that are open: the one a member keeps with its neighbor in the roster (WISP 902 § Transports) waits
    // for the closed hub to come back, and carries nothing until it does.
    const edgesOf = (p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === id && !peers.some(q => !q.online && view(q).myKey === e.peer)).map(e => e.peer);
    await world.until(() => edgesOf(author).length > 0 && edgesOf(author).every(k => newKeys.includes(k)), 10 * 60_000, 1000,
      () => `author's edges: ${edgesOf(author).map(k => peers.find(p => view(p)?.myKey === k)?.name).join(",")}`);

    expect(await author.groups.sendEdit(id, { id: kept, e: 1, ts: world.now, m: "A edited" })).toBeNull();
    expect(await author.groups.sendEdit(id, { id: gone, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true })).toBeNull();
    // Every member of the message's epoch still in the group, none of them on an edge with the author.
    const readers = peers.filter(p => p !== author && !old.includes(p) && p !== hubA && p !== hubB);
    // (Twice each, once per hub: the app shows an edit no newer than its text once.)
    const took = (p: Peer) => [kept, gone].every(m => (edits.get(p) ?? []).some(e => e.id === m));
    // A member still on its way to the newcomers gets them from a newcomer's catch-up once there.
    await world.until(() => readers.every(took), 5 * 60_000, 1000, () => `took both: ${readers.filter(took).length}/${readers.length}`);
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

describe("a deletion for everyone whose author is out of the group, on a hub let in after the message", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  // A hub let in after a message cannot open its edits, so it cannot tell a removal from another edit. Once the author
  // was out of the roster it dropped them all, and a member back whose only hub it was kept the message for good.
  it.each([
    [11, "removed after the hub carried it"], [22, "removed after the hub carried it"],
    [11, "gone before the hub was let in"], [33, "gone before the hub was let in"],
  ] as const)("reaches a member back whose only edge is that hub (seed %i, %s)", async (seed, when) => {
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
    const authorKey = view(author).myKey!;
    const gone = (await author.groups.send(id, "del B")).messageId!;
    await world.until(() => peers.every(p => world.texts(p, id).includes("del B")), 60_000, 1000);
    x.online = false;
    const out = async () => {
      if (when === "gone before the hub was let in") await author.groups.leave(id);
      else await admin.groups.remove(id, authorKey);
      await world.until(() => peers.filter(p => p.online && p !== author && world.member(p, id)).every(p => !view(p).members.some(m => m.key === authorKey)), 5 * 60_000, 1000);
    };
    const remove = () => author.groups.sendEdit(id, { id: gone, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true });
    let hubA: Peer | undefined;
    const readers = () => peers.filter(p => ![x, author, peers[2], peers[5], hubA].includes(p));
    const took = (p: Peer) => (got.get(p) ?? []).some(e => e.id === gone && e.rm);
    if (when === "gone before the hub was let in") {
      expect(await remove()).toBeNull();
      await world.until(() => readers().every(took), 60_000, 1000);
      await out();
    }

    // The hubs change: one leaves, the other's app closes, and a newcomer that stays online is the hub.
    await peers[2].groups.leave(id);
    peers[5].online = false;
    const hub = hubA = add("hubA", true);
    await join(hub);
    const keyOf = (p: Peer) => view(p).myKey!;
    const edgeUp = (p: Peer, to: Peer) => view(p).members.some(m => m.key === keyOf(to) && m.online && !m.viaHub);
    await world.until(() => view(hub).hubs?.hub === true && peers.filter(p => p.online && p !== hub && world.member(p, id)).every(p => edgeUp(p, hub)), 10 * 60_000, 1000);
    await world.run(60_000);
    if (when === "removed after the hub carried it") {
      expect(await remove()).toBeNull();
      await world.until(() => readers().every(took), 30_000, 1000);
      author.online = false;
      await out();
    }
    await world.run(60_000);

    // x comes back: only the hub hands it edits.
    world.drop = (from, to, frame) => frame.t === "group-edit" && to === x && from !== hub;
    world.reopen(x);
    await world.until(() => took(x), 240_000, 1000, () => `x took ${JSON.stringify(got.get(x) ?? [])}`);
    // The hub carried it unread.
    expect(got.get(hub) ?? []).toEqual([]);
  }, 300_000);
});
