import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
import { MESH_GAP_AGAIN_MS, MESH_GOSSIP_MS } from "../src/engine/groups";
// covers: groups.catch-up, groups.link.join

/**
 * The engine's side of "any member catches up the others" in a private group (WISP 902 § Catch-up): whom it asks,
 * how often, and the `group-here` hint, on headless engines (`CommunityWorld`, simulated clock).
 */

async function meshOf(names: string[], network = false): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld(undefined, network ? RELAY_NETWORK : null);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Catch-up", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}

/** Group messages delivered to `to`, by who handed them on. */
function counter(world: CommunityWorld) {
  const frames: { from: string; to: string; author: string; t: string }[] = [];
  world.drop = (from, to, frame) => {
    if (typeof frame.t === "string" && frame.t.startsWith("group-")) frames.push({ from: from.name, to: to.name, author: String(frame.s ?? ""), t: frame.t });
    return false;
  };
  return frames;
}

describe("a private group catches up a member from whoever is there", { timeout: 120_000 }, () => {
  it("a message sent while two members are cut apart reaches the other through a third, within a gossip turn", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob] = peers;
    world.cut = (a, b) => (a === alice && b === bob) || (a === bob && b === alice);
    await world.run(3_000);
    expect(world.view(bob, id)!.members.find(m => m.key === world.view(alice, id)!.myKey)!.online).toBe(false);
    const frames = counter(world);
    await alice.groups.send(id, "across the cut");
    await world.run(1_000);
    expect(world.texts(peers[2], id)).toContain("across the cut");
    expect(world.texts(bob, id)).not.toContain("across the cut");
    const took = await world.until(() => world.texts(bob, id).includes("across the cut"), MESH_GOSSIP_MS + 5_000);
    expect(took).toBeLessThanOrEqual(MESH_GOSSIP_MS + 1_000);
    // Handed on once, by one of the two who had it.
    expect(frames.filter(f => f.to === "bob" && f.t === "group-msg")).toHaveLength(1);
  });

  it("a member back from away gets each missed message about once, though every member holds it", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "erin", "frank"]);
    const [, bob, carol, , , frank] = peers;
    frank.online = false;
    await world.run(2_000);
    for (let i = 0; i < 5; i++) { await bob.groups.send(id, `bob ${i}`); await carol.groups.send(id, `carol ${i}`); }
    await world.run(2_000);
    bob.online = false; carol.online = false;
    await world.run(2_000);
    const frames = counter(world);
    world.reopen(frank);
    await world.until(() => world.texts(frank, id).filter(t => /^(bob|carol) /.test(t)).length === 10, 5 * 60_000);
    await world.run(MESH_GOSSIP_MS * 2);
    const toFrank = frames.filter(f => f.to === "frank" && f.t === "group-msg");
    expect(new Set(world.texts(frank, id)).size).toBe(world.texts(frank, id).length);
    // Three members hold all ten; one is asked for Bob's and Carol's, so ten frames, not thirty.
    expect(toFrank.length).toBe(10);
  });

  it("a member back gets an author's messages past the author's own log from another member, though the author is there", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob, , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    // Forty each: the authors keep their last 32 (`GROUP_LIMITS.outlog`), Carol holds all eighty.
    for (let i = 0; i < 40; i++) { await alice.groups.send(id, `alice ${i}`); await bob.groups.send(id, `bob ${i}`); }
    await world.run(2_000);
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).filter(t => /^(alice|bob) /.test(t)).length === 80, 5 * 60_000, 1000,
      () => `dave has ${world.texts(dave, id).filter(t => /^(alice|bob) /.test(t)).length} of 80`);
    expect(new Set(world.texts(dave, id)).size).toBe(world.texts(dave, id).length);
  });

  it("a member back after 200 messages of one author gets them in about a minute, not 32 a gossip turn", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    // Bob and Carol hold all 200 (256 kept); a sync names 32 of the missing at a time (`GROUP_LIMITS.miss`).
    for (let i = 0; i < 200; i++) await alice.groups.send(id, `alice ${i}`);
    await world.run(2_000);
    const syncs: { to: string; at: number }[] = [];
    const has = () => world.texts(dave, id).filter(t => t.startsWith("alice ")).length;
    world.drop = (from, to, frame) => { if (from === dave && frame.t === "group-sync") syncs.push({ to: to.name, at: world.now }); return false; };
    // Alice's edge comes up first: her own answer (her last 32) shows Dave what is below them, then Bob and Carol are there.
    world.cut = (a, b) => (a === dave || b === dave) && a !== alice && b !== alice;
    const back = world.now;
    world.reopen(dave);
    await world.until(() => has() === 32, 60_000);
    world.cut = null;
    await world.until(() => has() === 200, 10 * 60_000, 1000, () => `dave has ${has()} of 200`);
    const took = world.now - back;
    // Seven asks of 32, ten seconds apart (`MESH_GAP_AGAIN_MS`); one a gossip turn took 2 to 8 minutes.
    expect(took).toBeLessThanOrEqual(8 * MESH_GAP_AGAIN_MS);
    // Each member answers 8 syncs of one member a minute (`GROUP_LIMITS.syncAnswers`): none of these went unanswered.
    for (const { to, at } of syncs) expect(syncs.filter(s => s.to === to && s.at > at - 60_000 && s.at <= at).length).toBeLessThanOrEqual(8);
  });

  it("a member asks each other member once for messages nobody holds, not every gossip turn", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, , , dave] = peers;
    const aliceKey = world.view(alice, id)!.myKey!;
    const asks: string[] = [];
    // Alice's messages 0 to 9 reach nobody: Dave holds 10 and 11, so it names ten it never got.
    world.drop = (from, to, frame) => {
      if (from === dave && frame.t === "group-sync" && Array.isArray(frame.ask) && frame.ask.includes(aliceKey)) asks.push(to.name);
      return from === alice && frame.t === "group-msg" && (frame.n as number) < 10;
    };
    for (let i = 0; i < 12; i++) await alice.groups.send(id, `alice ${i}`);
    await world.run(MESH_GOSSIP_MS * 6);
    expect(world.texts(dave, id).filter(t => t.startsWith("alice "))).toHaveLength(2);
    // Bob and Carol, once each; Alice is not asked for her own.
    expect(asks.sort()).toEqual(["bob", "carol"]);
  });

  it("a member back after a while is announced once, and the others look fast for it", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "erin"], true);
    const erin = peers[4];
    erin.online = false;
    await world.run(3 * 60_000);
    const frames = counter(world);
    world.reopen(erin);
    const took = await world.until(() => world.view(erin, id)!.members.every(m => m.online), 10 * 60_000);
    const here = frames.filter(f => f.t === "group-here");
    // Whoever reached Erin first told the three others; the others, told, stayed quiet.
    expect(here.length).toBeGreaterThanOrEqual(3);
    expect(new Set(here.map(f => f.from)).size).toBeLessThanOrEqual(2);
    expect(took).toBeLessThan(2 * 60_000);
  });

  it("a member cannot keep another's edges looking fast: at most four hints a minute are acted on", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "erin", "frank", "gina", "hal"], true);
    const [alice, bob, ...rest] = peers;
    const away = rest.slice(1);
    for (const p of away) p.online = false;
    await world.run(5_000);
    const keyOf = (p: Peer) => world.view(p, id)!.myKey!;
    const fast = () => [...bob.links.values()].filter(e => e.kind === "edge" && away.some(p => keyOf(p) === e.peer) && e.fastUntil > world.now).length;
    expect(fast()).toBe(0);
    // Alice says all five are back, twice over.
    for (let round = 0; round < 2; round++) for (const p of away) await bob.groups.handleEdgeFrame(id, keyOf(alice), { t: "group-here", g: id, k: keyOf(p) });
    expect(fast()).toBe(4);
    await world.run(61_000);
    for (const p of away) await bob.groups.handleEdgeFrame(id, keyOf(alice), { t: "group-here", g: id, k: keyOf(p) });
    expect(fast()).toBeLessThanOrEqual(4);
  });
});
