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
