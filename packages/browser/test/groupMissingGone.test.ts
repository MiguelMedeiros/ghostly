import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_GOSSIP_MS } from "../src/engine/groups";
// covers: groups.catch-up

/**
 * What a member list says of messages nobody can hand on any more (WISP 902 § Bounds): an author keeps its last 32,
 * the others the group's last 256, and a member back after more than that has a gap no log fills.
 */

async function meshOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld(undefined, null);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Gone", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}

describe("a member list counts only the messages someone can still hand on", { timeout: 120_000 }, () => {
  it("a member back after 50 messages nobody else received stops counting the 18 no log holds", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob, carol, dave] = peers;
    const aliceKey = world.view(alice, id)!.myKey!;
    const missing = () => world.view(dave, id)!.members.find(m => m.key === aliceKey)!.missing;
    for (const p of [bob, carol, dave]) p.online = false;
    await world.run(2_000);
    // Fifty while nobody is there: Alice keeps her last 32 (`GROUP_LIMITS.outlog`), and nobody holds the first 18.
    for (let i = 0; i < 50; i++) await alice.groups.send(id, `alice ${i}`);
    await world.run(2_000);
    for (const p of [bob, carol, dave]) world.reopen(p);
    await world.until(() => world.texts(dave, id).filter(t => t.startsWith("alice ")).length === 32, 5 * 60_000);
    expect(missing()).toBe(18);
    // Bob and Carol are asked in turn, a gossip turn apart; neither holds them.
    await world.until(() => missing() === 0, 4 * MESH_GOSSIP_MS, 1000, () => `dave still counts ${missing()} missing`);
    // Alice goes on writing: the count stays down, and what she writes arrives.
    for (let i = 50; i < 56; i++) { await alice.groups.send(id, `alice ${i}`); await world.run(20_000); }
    expect(world.texts(dave, id).filter(t => t.startsWith("alice "))).toHaveLength(38);
    expect(missing()).toBe(0);
  });

  it("the count comes down while the author goes on writing", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob, carol, dave] = peers;
    const aliceKey = world.view(alice, id)!.myKey!;
    const missing = () => world.view(dave, id)!.members.find(m => m.key === aliceKey)!.missing;
    for (const p of [bob, carol, dave]) p.online = false;
    await world.run(2_000);
    for (let i = 0; i < 50; i++) await alice.groups.send(id, `alice ${i}`);
    await world.run(2_000);
    for (const p of [bob, carol, dave]) world.reopen(p);
    await world.until(() => missing() === 18, 5 * 60_000);
    // A message every twenty seconds, as an agent at work writes: each one arrives, and none is one of the 18.
    let sent = 50;
    for (let turn = 0; turn < 12 && missing() > 0; turn++) { await alice.groups.send(id, `alice ${sent++}`); await world.run(MESH_GOSSIP_MS / 3); }
    expect(missing()).toBe(0);
    expect(world.texts(dave, id).filter(t => t.startsWith("alice "))).toHaveLength(32 + sent - 50);
  });

  it("messages another member still holds are counted until they arrive", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, , carol, dave] = peers;
    const aliceKey = world.view(alice, id)!.myKey!;
    const missing = () => world.view(dave, id)!.members.find(m => m.key === aliceKey)!.missing;
    const has = () => world.texts(dave, id).filter(t => t.startsWith("alice ")).length;
    for (const p of [carol, dave]) p.online = false;
    await world.run(2_000);
    // Bob is there and keeps all fifty (`GROUP_LIMITS.relay`); Carol, away too, holds none of them.
    for (let i = 0; i < 50; i++) await alice.groups.send(id, `alice ${i}`);
    await world.run(2_000);
    for (const p of [carol, dave]) world.reopen(p);
    await world.until(() => has() >= 32, 5 * 60_000);
    // Not written off while Bob was not asked yet: the count goes down only as the messages come in.
    for (let s = 0; s < 5 * 60 && has() < 50; s++) { expect(missing()).toBe(50 - has()); await world.run(1_000); }
    expect(has()).toBe(50);
    expect(missing()).toBe(0);
  });
});
