import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_SYNC_HOLD_MAX_MS } from "../src/engine/groups";
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

  it("the member asked first was away too: the others are told once it has nothing more, and all of it arrives", async () => {
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
    expect(took).toBeLessThanOrEqual(MESH_SYNC_HOLD_MAX_MS);
    // Each member's own lines in its order, whatever the order between members.
    for (const p of [bob, carol, eve]) expect(world.texts(dave, id).filter(t => t.startsWith(`${p.name} `))).toEqual(written.filter(t => t.startsWith(`${p.name} `)));
  });
});
