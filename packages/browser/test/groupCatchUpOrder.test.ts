import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_SYNC_HOLD_MS } from "../src/engine/groups";
// covers: groups.catch-up

/**
 * What a member back in a private group reads of what the others wrote meanwhile (WISP 902 § Catch-up): the
 * conversation in the order it was written, though every member's edge opens within a moment of the first. The first
 * member is asked for everyone's messages and holds them in that order; the others' own answers must not race it.
 */

async function meshOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld(undefined, null);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Turns", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}

/** Each of `writers` in turn, `turns` times; what they wrote, in order. Two never share a millisecond. */
async function talk(world: CommunityWorld, id: string, writers: Peer[], turns: number): Promise<string[]> {
  const written: string[] = [];
  for (let turn = 0; turn < turns; turn++) for (const p of writers) {
    const text = `${p.name} ${turn}`;
    written.push(text);
    await p.groups.send(id, text);
    await new Promise(done => setTimeout(done, 2));
    await world.run(1_000);
  }
  return written;
}

/**
 * `back` opens again: its edge to `first` comes up, and the others' only once it has told `first` where it is, in the
 * same moment, as edges do that open one after another. `first`'s frames reach it four at a time.
 */
function comesBack(world: CommunityWorld, back: Peer, first: Peer): void {
  let told = false;
  world.drop = (from, to, frame) => { if (from === back && to === first && frame.t === "group-sync") told = true; return false; };
  world.holdEdge = (a, b) => (a === back || b === back) && a !== first && b !== first && !told;
  world.slow = (from, to) => from === first && to === back ? 4 : 0;
  world.reopen(back);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a member back in a private group reads what it missed in the order it was written", { timeout: 120_000 }, () => {
  it("five members, four wrote in turn: no member's lines come ahead of their turn", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 6);
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("the member asked first was away too: the others are told one after another, each asked for the rest", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    alice.online = dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [bob, carol, eve], 4);
    world.reopen(alice);
    // Alice is back but has not caught up: cut from the others, she holds none of it when Dave asks her.
    world.cut = (a, b) => (a === alice || b === alice) && a !== dave && b !== dave;
    comesBack(world, dave, alice);
    const took = await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(took).toBeLessThanOrEqual(10_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("a member asked of another a moment ago, and reached since, is asked of the first member again", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    // Dave opens while Eve is away, and asks Alice, the first member it reaches, for her messages; then she is back.
    eve.online = dave.online = false;
    await world.run(2_000);
    comesBack(world, dave, alice);
    await world.run(5_000);
    world.reopen(eve);
    await world.run(5_000);
    expect(world.view(dave, id)!.members.every(m => m.online)).toBe(true);
    // Under a minute later Dave is away, and back: what was asked for Eve then says nothing of what she wrote since.
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 3);
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("an answer of 200 messages that takes fifty seconds: the others are told only once it has come", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve", "frank"]);
    const [alice, bob, carol, dave, eve, frank] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [bob, carol, eve, frank], 50);
    // Four frames a second of the clock: a phone with a long history handles a frame in hundreds of milliseconds.
    world.slowByClock = true;
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("one member wrote 200 and every edge opens at once: that member's lines in the order written, the newest last", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 200; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    // Alice's own answer brings her newest 32; the older ones come from the others, asked for 32 at a time.
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(1_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("a reply to the newest line, written before the older ones came, stays below the lines it answers", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 120; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    // Her newest come first: Dave answers the last line as soon as it shows, while the older ones are on their way.
    await world.until(() => world.texts(dave, id).includes("alice 120"), 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t)).length).toBeLessThan(written.length);
    const reply = "dave: re alice 120";
    await dave.groups.send(id, reply);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(20_000);
    expect(world.texts(dave, id).filter(t => written.includes(t) || t === reply)).toEqual([...written, reply]);
  });

  it("one member wrote 200 and the older ones come 32 at a time: each row is placed again about once, not once a page", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 200; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    const placeAgain = dave.host.placeAgain!;
    let calls = 0, rows = 0;
    dave.host.placeAgain = async (linkId, ids) => { calls++; rows += ids.length; await placeAgain(linkId, ids); };
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(20_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
    // Her newest 32 came first (her own answer), the rest from the others a page at a time: one move once all came.
    expect(calls).toBe(1);
    expect(rows).toBeLessThanOrEqual(written.length);
  });

  it("what the member asked first writes meanwhile is not its answer: the others are told as soon as that has come", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 3);
    comesBack(world, dave, alice);
    const back = world.now;
    let toldNext = 0;
    const drop = world.drop!;
    world.drop = (from, to, frame) => { if (from === dave && to !== alice && frame.t === "group-sync") toldNext ||= world.now; return drop(from, to, frame); };
    // From here a message carries the world's time, as the engines' clocks do: Alice writes one every second.
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    for (let i = 0; i < 12; i++) { await alice.groups.send(id, `alice now ${i}`); await world.run(1_000); }
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
    expect(toldNext - back).toBeGreaterThanOrEqual(MESH_SYNC_HOLD_MS);
    expect(toldNext - back).toBeLessThanOrEqual(5_000);
  });
});
