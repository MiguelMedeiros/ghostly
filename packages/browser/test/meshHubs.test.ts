import { describe, expect, it } from "vitest";
import { MESH_HUBS, beaconKeys, lobbyKeys, lobbyRecords, meshRendezvous, readBeacon, fromBase64Url, type GroupState } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.hubs, groups.hubs.budget, groups.send, groups.catch-up, groups.remove-member, groups.leave

/**
 * Hubs in a private group past 16 members (WISP 902 · Group Mesh § Hubs), on headless engines (the real `Groups`,
 * `MeshHubs` and `GroupSession`; Pkarr and links in memory, simulated clock). Members whose apps stay online (Desktop,
 * CLI: `staysOnline`) become hubs; the others keep edges with two of them; hubs pass every frame on.
 */

interface Built { world: CommunityWorld; id: string; admin: Peer; peers: Peer[] }

/** A group of `n` joined one after another through the admin's link; `hubs` and `legacy` name peers by index (0 is the admin). */
/** Reactions each peer took, as the app's reactions store would: who, on what, which emoji. */
const reactions = new Map<Peer, { member: string; id: string; e: string; n: number }[]>();

async function build(n: number, opts: { hubs?: number[]; legacy?: number[]; budgets?: Record<number, { peerBudget: number; heldElsewhere: number }> } = {}): Promise<Built> {
  const world = new CommunityWorld();
  const app = (i: number) => ({ staysOnline: opts.hubs?.includes(i), legacy: opts.legacy?.includes(i), ...opts.budgets?.[i] });
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
    // The edges that are not wanted close (the admin's with the last members it let in after two minutes).
    await world.run(150_000);
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

  it("the admin removes a hub, then the last one: everyone moves on at once, then falls back and still reads each other", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, admin, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    await world.run(150_000);
    const [first, last] = [peers[2], peers[5]];
    // The admin has edges with the hubs only: the removed hub passes on the commit that removes it.
    await admin.groups.remove(id, keyOf(b, first));
    const others = peers.filter(p => p !== first);
    await world.until(() => others.every(p => view(b, p).members.length === 19 && view(b, p).canSend), 60_000, 500,
      () => others.filter(p => view(b, p).members.length !== 19 || !view(b, p).canSend).map(p => p.name).join(","));
    expect(view(b, first).status).toBe("removed");
    await peers[9].groups.send(id, "one hub left");
    await world.run(3_000);
    for (const p of others) expect(world.texts(p, id)).toContain("one hub left");
    // The last hub goes too: the group falls back to direct edges, and nothing said is lost.
    await admin.groups.remove(id, keyOf(b, last));
    const rest = others.filter(p => p !== last);
    await world.until(() => rest.every(p => view(b, p).members.length === 18 && view(b, p).canSend), 60_000, 500);
    await peers[11].groups.send(id, "no hub at all");
    await world.until(() => rest.every(p => world.texts(p, id).includes("no hub at all")), 10 * 60_000, 1000,
      () => rest.filter(p => !world.texts(p, id).includes("no hub at all")).map(p => p.name).join(","));
    expect(rest.every(p => !view(b, p).hubs)).toBe(true);
  }, 300_000);

  it("a member whose epoch secret has not arrived, with no hub picked, keeps its edges and catches up", async () => {
    const b = await build(20, { hubs: [2, 5] });
    const { world, id, peers } = b;
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    await world.run(150_000);
    const m = peers[12];
    const g = m.groups as unknown as { sessions: Map<string, { state: GroupState; epoch: number }>; hubs: { live: Map<string, { myHubs: string[] }> } };
    const session = g.sessions.get(id)!;
    const secret = session.state.secrets[session.epoch];
    delete session.state.secrets[session.epoch];
    g.hubs.live.get(id)!.myHubs = [];
    const before = edgesOf(b, m).length;
    await world.run(30_000);
    // Nothing closed while it could not pick (no rendezvous without the secret).
    expect(edgesOf(b, m).length).toBeGreaterThanOrEqual(before);
    await peers[9].groups.send(id, "while you wait");
    await world.until(() => world.texts(m, id).includes("while you wait"), 5 * 60_000, 1000);
    expect(session.state.secrets[session.epoch]).toBe(secret);
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
    await world.run(150_000);
    const leaver = peers[13], leaverKey = keyOf(b, leaver);
    expect(edgesOf(b, leaver).some(e => e.peer === keyOf(b, admin))).toBe(false);
    await leaver.groups.leave(id);
    await world.until(() => !view(b, admin).members.some(m => m.key === leaverKey), 5 * 60_000, 500);
    // The admin's commit came back through a hub: the tombstone is gone.
    for (let i = 0; i < 600 && (await leaver.store.getGroups()).some(g => g.id === id); i++) await world.run(500, 500);
    expect((await leaver.store.getGroups()).some(g => g.id === id)).toBe(false);
  }, 300_000);
});

/**
 * A Mac's budget of connections (WISP 902 · Group Mesh § Hubs, Budget): WKWebView opens only about 46 in one page, and
 * past that a call does not connect, so the Desktop app on a Mac gives its groups 40 (`peerBudget`). Being a hub of a
 * group of 20 takes 19 edges; `heldElsewhere` stands for groups outside this world (31: the hub of a group of 32).
 */
describe("a Mac's budget of connections", () => {
  const onMac = (heldElsewhere: number, peerBudget = 40) => ({ peerBudget, heldElsewhere });
  const isHub = (b: Built, p: Peer) => view(b, p).hubs?.hub === true;
  /** Whether each of `ps` is a hub, every 30 s for `ms`: how the hubs stand over several beacon cycles. */
  const watch = async (b: Built, ps: Peer[], ms: number) => {
    const seen: string[] = [];
    for (let t = 0; t < ms; t += 30_000) { await b.world.run(30_000); seen.push(ps.map(p => isHub(b, p) ? "H" : "-").join("")); }
    return seen;
  };

  it("a hub steps down when another group takes its room, its members move to the other hub, and it is one again when the room is back", async () => {
    const b = await build(20, { hubs: [2, 5], budgets: { 2: onMac(0) } });
    const { world, id, peers } = b;
    const mac = peers[2];
    // Within its budget, a Mac is a hub as any app that stays online.
    await world.until(() => isHub(b, mac) && isHub(b, peers[5]) && onHubs(b) && allReach(b), 10 * 60_000, 1000);
    // Another group of 32 it is a hub of: 31 connections there, 9 left, and this group's hub needs 19.
    mac.heldElsewhere = 31;
    await world.until(() => !isHub(b, mac), 60_000, 1000);
    const others = peers.filter(p => p !== peers[5]);
    await world.until(() => others.every(p => edgesOf(b, p).length <= MESH_HUBS.hubsPerMember + (p === b.admin ? 1 : 0)) && allReach(b), 10 * 60_000, 1000,
      () => others.filter(p => edgesOf(b, p).length > MESH_HUBS.hubsPerMember).map(p => `${p.name}:${edgesOf(b, p).length}`).join(" "));
    expect(await watch(b, [mac], 5 * 60_000)).not.toContain("H");
    await peers[9].groups.send(id, "after the Mac stepped down");
    await world.run(2_000);
    for (const p of peers) expect(world.texts(p, id)).toContain("after the Mac stepped down");
    // The other group gone: room again, and a hub again.
    mac.heldElsewhere = 0;
    await world.until(() => isHub(b, mac), 5 * 60_000, 1000);
  }, 300_000);

  it("over its budget, the only member that could be a hub is none: the group is a full mesh, the Mac keeps the edges it has room for, and messages still reach it", async () => {
    const b = await build(20, { hubs: [2], budgets: { 2: onMac(31) } });
    const { world, id, peers } = b;
    const mac = peers[2];
    await world.until(() => peers.every(p => view(b, p).members.length === 20) && edgesOf(b, mac).length > 0, 10 * 60_000, 1000);
    expect(await watch(b, [mac], 5 * 60_000)).not.toContain("H");
    for (const p of peers) expect(view(b, p).hubs).toBeUndefined();
    // 40 less 31: nine edges, the admin's among them.
    expect(edgesOf(b, mac).length).toBeLessThanOrEqual(9);
    expect(edgesOf(b, mac).some(e => e.peer === keyOf(b, b.admin))).toBe(true);
    await peers[15].groups.send(id, "to a Mac with nine edges");
    await mac.groups.send(id, "from a Mac with nine edges");
    await world.until(() => world.texts(mac, id).includes("to a Mac with nine edges") && peers.every(p => world.texts(p, id).includes("from a Mac with nine edges")), 5 * 60_000, 1000);
  }, 300_000);

  it("a Mac in two large groups is the hub of the one it has room for, and stays so", async () => {
    // A budget of 30: a hub of a group of 20 (19 edges) leaves 11, too few for a second hub.
    const a = await build(20, { hubs: [2, 5], budgets: { 2: onMac(0, 30) } });
    const { world, peers } = a;
    const mac = peers[2];
    await world.until(() => isHub(a, mac) && onHubs(a) && allReach(a), 10 * 60_000, 1000);
    // A second group, of the same members, another admin.
    const admin = peers[1], id = await admin.groups.create("Second", "mesh");
    const link = await admin.groups.enableLink(id);
    for (const p of peers.filter(p => p !== admin)) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000, 500); }
    const b: Built = { world, id, admin, peers: [admin, ...peers.filter(p => p !== admin)] };
    await world.until(() => onHubs(b) && allReach(b), 10 * 60_000, 1000);
    const seen = await watch(a, [mac], 10 * 60_000), seenB = await watch(b, [mac], 5 * 60_000);
    expect(seen).not.toContain("-");
    expect(seenB).not.toContain("H");
    expect(mac.links.size).toBeLessThanOrEqual(30);
    expect(edgesOf(b, mac).length).toBeLessThanOrEqual(MESH_HUBS.hubsPerMember);
  }, 300_000);

  it("in a full mesh of 12, a Mac with room for five keeps five edges, the admin's first", async () => {
    const b = await build(12, { budgets: { 4: onMac(35) } });
    const { world, id, peers } = b;
    const mac = peers[4];
    await world.until(() => edgesOf(b, mac).length === 5 && peers.every(p => view(b, p).members.length === 12), 10 * 60_000, 1000);
    await world.run(5 * 60_000);
    expect(edgesOf(b, mac).length).toBe(5);
    expect(edgesOf(b, mac).some(e => e.peer === keyOf(b, b.admin))).toBe(true);
    await peers[9].groups.send(id, "five edges are enough");
    await world.until(() => world.texts(mac, id).includes("five edges are enough"), 5 * 60_000, 1000);
    // Room again: every edge.
    mac.heldElsewhere = 0;
    await world.until(() => edgesOf(b, mac).length === 11, 5 * 60_000, 1000);
  }, 300_000);
});
