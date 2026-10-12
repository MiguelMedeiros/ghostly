import { describe, expect, it } from "vitest";
import { GROUP_LIMITS } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.catch-up

/**
 * A private group's record holds its session's state, the 256 frames kept for members who were away included, and was
 * written whole for every message received. The engine's side of the one save a burst now takes
 * (`GROUP_LIMITS.saveWithinMs`), on headless engines (`CommunityWorld`).
 */

async function meshOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld();
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Saves", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}

/** Counts the writes of `peer`'s group records from now on, and their bytes as JSON. */
function writes(peer: Peer) {
  const seen = { count: 0, bytes: 0 };
  const put = peer.store.putGroup.bind(peer.store);
  peer.store.putGroup = async group => { seen.count++; seen.bytes += JSON.stringify(group).length; await put(group); };
  return seen;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("a private group's record is written once for the messages that come together", { timeout: 120_000 }, () => {
  it("a member back in a busy group writes its record a few times, not once per message it missed", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol"]);
    const [alice, bob, carol] = peers;
    carol.online = false;
    await world.run(2_000);
    for (let i = 0; i < 30; i++) { await alice.groups.send(id, `alice ${i} ${"x".repeat(200)}`); await bob.groups.send(id, `bob ${i} ${"x".repeat(200)}`); }
    await world.run(2_000);
    const seen = writes(carol);
    world.reopen(carol);
    await world.until(() => world.texts(carol, id).filter(t => /^(alice|bob) /.test(t)).length === 60, 5 * 60_000);
    // What is due is written within the wait.
    await pause(GROUP_LIMITS.saveWithinMs + 200);
    expect(seen.count).toBeLessThan(20);
    const stored = (await carol.store.getGroups()).find(g => g.id === id)!;
    expect(Object.values(stored.state!.seen).map(epochs => Math.max(...Object.values(epochs).map(e => e.high))).sort()).toEqual([29, 29]);
  });

  it("an app that quits right after the messages has them in its record, and takes none again", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob"]);
    const [alice, bob] = peers;
    for (let i = 0; i < 5; i++) await alice.groups.send(id, `line ${i}`);
    await world.settle();
    expect(world.texts(bob, id).filter(t => t.startsWith("line "))).toHaveLength(5);
    await world.restart(bob);
    const stored = (await bob.store.getGroups()).find(g => g.id === id)!;
    expect(Object.values(stored.state!.seen).map(epochs => Math.max(...Object.values(epochs).map(e => e.high)))).toEqual([4]);
    await world.run(5_000);
    expect(world.texts(bob, id).filter(t => t.startsWith("line "))).toHaveLength(5);
  });
});
