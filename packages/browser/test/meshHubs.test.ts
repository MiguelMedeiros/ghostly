import { describe, expect, it } from "vitest";
import { MESH_HUBS, beaconKeys, lobbyKeys, lobbyRecords, meshRendezvous, readBeacon, fromBase64Url, type GroupState } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.send, groups.catch-up, groups.remove-member, groups.leave

/**
 * Hubs in a private group past 16 members (WISP 9xx · Group Mesh § Hubs), on headless engines (the real `Groups`,
 * `MeshHubs` and `GroupSession`; Pkarr and links in memory, simulated clock). Members whose apps stay online (Desktop,
 * CLI: `staysOnline`) become hubs; the others keep edges with two of them; hubs pass every frame on.
 */

interface Built { world: CommunityWorld; id: string; admin: Peer; peers: Peer[] }

/** A group of `n` joined one after another through the admin's link; `hubs` and `legacy` name peers by index (0 is the admin). */
/** Reactions each peer took, as the app's reactions store would: who, on what, which emoji. */
const reactions = new Map<Peer, { member: string; id: string; e: string; n: number }[]>();

async function build(n: number, opts: { hubs?: number[]; legacy?: number[] } = {}): Promise<Built> {
  const world = new CommunityWorld();
  const app = (i: number) => ({ staysOnline: opts.hubs?.includes(i), legacy: opts.legacy?.includes(i) });
  const hooks = (p: Peer) => ({ groupReaction: (_g: string, member: string, r: { id: string; e: string; n: number }) => { reactions.set(p, [...reactions.get(p) ?? [], { member, ...r }]); } });
  const admin = world.add("admin", hooks, app(0));
  const id = await admin.groups.create("Hubs", "mesh");
  const link = await admin.groups.enableLink(id);
  const peers = [admin];
  for (let i = 1; i < n; i++) {
    const p = world.add(`p${i}`, hooks, app(i));
    await p.groups.joinByLink(link);
    await world.until(() => world.member(p, id), 5 * 60_000, 500);
    peers.push(p);
  }
  return { world, id, admin, peers };
}

const view = (b: Built, p: Peer) => b.world.view(p, b.id)!;
const keyOf = (b: Built, p: Peer) => view(b, p).myKey!;
const edgesOf = (b: Built, p: Peer) => [...p.links.values()].filter(e => e.kind === "edge" && e.g === b.id);
const upEdges = (b: Built, p: Peer) => view(b, p).members.filter(m => !m.me && m.online && !m.viaHub).length;
/** Everyone sees everyone as reachable: by an edge or through a hub. */
const allReach = (b: Built, ps = b.peers) => ps.every(p => view(b, p).members.length === ps.length && view(b, p).members.every(m => m.online));
const onHubs = (b: Built, ps = b.peers) => ps.every(p => !!view(b, p).hubs);

describe("hubs in a private group past 16 members", () => {
  it("members keep edges with two hubs, and a message reaches everyone through them", async () => {
    const b = await build(24, { hubs: [3, 7] });
    const { world, id, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000, () => `hubs ${peers.filter(p => !view(b, p).hubs).length} off; reach ${peers.filter(p => !view(b, p).members.every(m => m.online)).map(p => p.name).slice(0, 3)}`);
    // The edges that are not wanted close.
    await world.run(60_000);
    const hubs = [peers[3], peers[7]], others = peers.filter(p => !hubs.includes(p));
    for (const p of others) {
      expect(edgesOf(b, p).length).toBeLessThanOrEqual(MESH_HUBS.hubsPerMember);
      expect(view(b, p).hubs).toEqual({ hub: false });
    }
    for (const h of hubs) expect(view(b, h).hubs).toEqual({ hub: true });
    // Every member sees the hubs marked, and the others reached through them.
    const v = view(b, others[5]);
    expect(v.members.filter(m => m.hub).map(m => m.key).sort()).toEqual(hubs.map(h => keyOf(b, h)).sort());
    expect(v.members.filter(m => m.viaHub).length).toBe(24 - 1 - 2);

    const before = others[4].sent.frames;
    await others[4].groups.send(id, "through the hubs");
    await world.run(2_000);
    for (const p of peers) expect(world.texts(p, id)).toContain("through the hubs");
    // Its author sent it twice, once per hub.
    expect(others[4].sent.frames - before).toBe(2);
    // Each exactly once, though two hubs passed it on.
    for (const p of peers) expect(world.texts(p, id).filter(t => t === "through the hubs")).toHaveLength(1);
  }, 180_000);

  it("a reaction, signed by its member, reaches everyone through a hub; an older app never takes it as the hub's", async () => {
    const b = await build(20, { hubs: [2, 5], legacy: [8] });
    const { world, id, peers } = b;
    const old = peers[8], hubs = [peers[2], peers[5]], others = peers.filter(p => p !== old && !hubs.includes(p));
    await world.until(() => onHubs(b, others) && others.every(p => edgesOf(b, p).length <= MESH_HUBS.hubsPerMember + (p === b.admin ? 1 : 0)), 10 * 60_000, 1000);
    const reactor = others[3], reactorKey = keyOf(b, reactor);
    const wire = { id: `${keyOf(b, others[4])}:0:0`, e: "👍", n: 1 };
    // What the app says on each of the reactor's edges: the wire fields and the member's signature.
    const frame = { t: "group-react", g: id, ...wire, ...reactor.groups.signReaction(id, wire) };
    const hub = hubs.find(h => edgesOf(b, reactor).some(e => e.peer === keyOf(b, h)))!;
    await hub.groups.handleEdgeFrame(id, reactorKey, structuredClone(frame));
    await world.run(1_000);
    for (const p of peers.filter(p => p !== reactor && p !== old)) expect(reactions.get(p)?.some(r => r.member === reactorKey && r.id === wire.id && r.e === "👍")).toBe(true);
    // The older app drops what a hub passes on: nothing in its name, nor in the hub's.
    expect(reactions.get(old)?.some(r => r.id === wire.id) ?? false).toBe(false);
    // Forged: another member's name on it, and the same signature.
    const forged = { ...frame, t: "group-reacted", k: keyOf(b, others[6]) };
    await others[7].groups.handleEdgeFrame(id, keyOf(b, hub), structuredClone(forged));
    expect(reactions.get(others[7])?.some(r => r.member === keyOf(b, others[6])) ?? false).toBe(false);
  }, 180_000);

  it("a group of 16 stays a full mesh, whatever hubs there could be", async () => {
    const b = await build(16, { hubs: [2] });
    await b.world.until(() => allReach(b), 10 * 60_000, 1000);
    await b.world.run(90_000);
    for (const p of b.peers) { expect(view(b, p).hubs).toBeUndefined(); expect(upEdges(b, p)).toBe(15); }
  }, 180_000);

  it("with its hubs gone the group falls back to direct edges, and back to hubs when one returns", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    const hubs = [peers[2], peers[5]], others = peers.filter(p => !hubs.includes(p));
    for (const h of hubs) h.online = false;
    // Within the grace (a hub restarting, a reading that missed it) the members wait for them; then, the full mesh.
    await world.until(() => others.every(p => !view(b, p).hubs && upEdges(b, p) === others.length - 1), 10 * 60_000, 1000,
      () => others.map(p => `${p.name}:${upEdges(b, p)}`).slice(0, 4).join(" "));
    await others[3].groups.send(id, "no hub here");
    await world.run(2_000);
    for (const p of others) expect(world.texts(p, id)).toContain("no hub here");
    // One hub back: the members move to it, and what they said meanwhile reaches it.
    world.reopen(hubs[0]);
    await world.until(() => onHubs(b, others) && others.every(p => edgesOf(b, p).length <= MESH_HUBS.hubsPerMember), 10 * 60_000, 1000);
    await world.until(() => world.texts(hubs[0], id).includes("no hub here"), 5 * 60_000, 1000);
    await others[6].groups.send(id, "one hub again");
    await world.run(2_000);
    for (const p of [...others, hubs[0]]) expect(world.texts(p, id)).toContain("one hub again");
  }, 300_000);

  it("a removed member reads nothing after, is carried for by no hub, and cannot find the new beacon", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, admin, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    const gone = peers[9], goneKey = keyOf(b, gone);
    const oldState = structuredClone((await gone.store.getGroups()).find(g => g.id === id)!.state!) as GroupState;
    await admin.groups.remove(id, goneKey);
    const others = peers.filter(p => p !== gone);
    await world.until(() => others.every(p => view(b, p).members.length === 19 && view(b, p).canSend), 5 * 60_000, 500,
      () => others.filter(p => view(b, p).members.length !== 19 || !view(b, p).canSend).map(p => p.name).join(","));
    expect(view(b, gone).status).toBe("removed");
    await peers[4].groups.send(id, "after the removal");
    await world.run(5_000);
    for (const p of others) expect(world.texts(p, id)).toContain("after the removal");
    expect(world.texts(gone, id)).not.toContain("after the removal");
    // The beacon moved with the epoch: the old rendezvous secret opens nothing any more, the new one lists the hubs.
    const epoch = view(b, admin).epoch!;
    const current = (await admin.store.getGroups()).find(g => g.id === id)!.state!;
    const rvNew = meshRendezvous(fromBase64Url(current.secrets[epoch]), id, epoch);
    const rvOld = meshRendezvous(fromBase64Url(oldState.secrets[epoch - 1]), id, epoch - 1);
    expect(rvOld).not.toBe(rvNew);
    const fresh = readBeacon(beaconKeys(rvNew, id), world.pkarr.get(beaconKeys(rvNew, id).identity.pubKeyZ32) ?? []);
    expect(fresh.map(h => h.key).sort()).toEqual([keyOf(b, peers[2]), keyOf(b, peers[5])].sort());
    // Written with what it had, its request in a hub's lobby is refused: it is not in the roster.
    const lobby = lobbyKeys(rvNew, id, keyOf(b, peers[2]));
    world.pkarr.set(lobby.identity.pubKeyZ32, lobbyRecords(lobby, [{ key: goneKey, ts: world.now }]));
    await world.run(60_000);
    expect(edgesOf(b, peers[2]).some(e => e.peer === goneKey)).toBe(false);
    // Nobody keeps its frames to hand on.
    for (const p of others) expect((await p.store.getGroups()).find(g => g.id === id)?.state?.relay?.some(f => f.s === goneKey) ?? false).toBe(false);
  }, 300_000);

  it("an app without hubs keeps its edges with the hubs, and reads and is read by everyone", async () => {
    const b = await build(20, { hubs: [2, 5], legacy: [8] });
    const { world, id, peers } = b;
    const old = peers[8], hubs = [peers[2], peers[5]], others = peers.filter(p => p !== old && !hubs.includes(p));
    // The admin keeps one more edge, with the old app (below).
    await world.until(() => onHubs(b, others) && others.every(p => edgesOf(b, p).length <= MESH_HUBS.hubsPerMember + (p === b.admin ? 1 : 0)), 10 * 60_000, 1000,
      () => others.map(p => `${p.name}:${view(b, p).hubs ? "h" : "m"}${edgesOf(b, p).length}`).join(" "));
    // The old app never runs on hubs; the hubs (and the admin) keep their edges with it.
    expect(view(b, old).hubs).toBeUndefined();
    const oldKey = keyOf(b, old);
    for (const h of hubs) expect(view(b, h).members.find(m => m.key === oldKey)?.online).toBe(true);
    await old.groups.send(id, "from an older app");
    await others[2].groups.send(id, "to an older app");
    await world.run(2_000);
    for (const p of peers) expect(world.texts(p, id)).toContain("from an older app");
    expect(world.texts(old, id)).toContain("to an older app");
    // A commit reaches it too: its admin keeps an edge with it for the secret.
    await b.admin.groups.rotate(id);
    await world.until(() => view(b, old).epoch === view(b, b.admin).epoch && view(b, old).canSend, 5 * 60_000, 500);
  }, 300_000);

  it("the admin pins a member as a hub and excludes another", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, admin, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    const pinned = peers[11], excluded = peers[5];
    await admin.groups.setHub(id, keyOf(b, pinned), "pin");
    await admin.groups.setHub(id, keyOf(b, excluded), "exclude");
    await world.until(() => view(b, pinned).hubs?.hub === true && view(b, excluded).hubs?.hub === false, 5 * 60_000, 1000);
    const v = view(b, peers[14]);
    expect(v.members.find(m => m.key === keyOf(b, pinned))?.hubRole).toBe("pin");
    expect(v.members.find(m => m.key === keyOf(b, excluded))?.hubRole).toBe("exclude");
    // Nobody keeps an edge with the excluded member for its hubs, once the beacon is read again.
    await world.until(() => peers.filter(p => p !== excluded && !view(b, p).hubs?.hub).every(p => !edgesOf(b, p).some(e => e.peer === keyOf(b, excluded))), 5 * 60_000, 1000);
    // No line in the history for it: the picture did not change.
    expect(peers[14].messages.some(m => m.event === "picture")).toBe(false);
    await peers[14].groups.send(id, "pinned hub");
    await world.run(2_000);
    for (const p of peers) expect(world.texts(p, id)).toContain("pinned hub");
  }, 300_000);

  it("a member leaves through its hubs when it has no edge with the admin", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, admin, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    await world.run(60_000);
    const leaver = peers[13], leaverKey = keyOf(b, leaver);
    expect(edgesOf(b, leaver).some(e => e.peer === keyOf(b, admin))).toBe(false);
    await leaver.groups.leave(id);
    await world.until(() => !view(b, admin).members.some(m => m.key === leaverKey), 5 * 60_000, 500);
    // The admin's commit came back through a hub: the tombstone is gone.
    for (let i = 0; i < 600 && (await leaver.store.getGroups()).some(g => g.id === id); i++) await world.run(500, 500);
    expect((await leaver.store.getGroups()).some(g => g.id === id)).toBe(false);
  }, 300_000);
});
