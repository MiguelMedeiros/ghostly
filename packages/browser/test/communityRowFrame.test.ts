import { describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.catch-up

/**
 * A community's message is stored with the frame it came in (`StoredMessage.frame`), as a private group's is: the
 * record no longer carries the store of 256 frames, which cost each member 128 KB a message received and 247 KB a
 * message sent once it was full (CLI daemons, agents#1958).
 */
async function communityOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld();
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Frames");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => rest.every(p => world.member(p, id)), 5 * 60_000);
  await world.run(60_000);
  return { world, peers, id };
}
const said = (peer: Peer, id: string) => peer.messages.filter(m => m.linkId === `group:${id}` && !m.event);
/** What the engine does with a line its author deleted for everyone (`forgetGroupMessage`): noted, the row gone. */
async function deleteForEveryone(peer: Peer, id: string, messageId: string): Promise<void> {
  const row = peer.messages.find(m => m.id === messageId)!;
  await peer.groups.removed(id, messageId);
  peer.messages.splice(peer.messages.indexOf(row), 1);
}

describe("a community's message keeps the frame it came in", { timeout: 240_000 }, () => {
  it("on its row, on the author's side too, and the record stays small", async () => {
    const { world, peers, id } = await communityOf(["alice", "bob"]);
    const [alice, bob] = peers;
    const sizes: number[] = [];
    const put = bob.store.putGroup.bind(bob.store);
    bob.store.putGroup = async group => { if (group.id === id) sizes.push(JSON.stringify(group).length); await put(group); };
    for (let i = 0; i < 50; i++) { await alice.groups.send(id, `line ${i} ${"x".repeat(200)}`); await world.run(2_000); await bob.groups.communities.session(id)!.flush(); }
    await alice.groups.communities.session(id)!.flush();
    expect(said(bob, id).filter(m => m.frame)).toHaveLength(50);
    expect(said(alice, id).filter(m => m.frame)).toHaveLength(50);
    const row = said(bob, id)[0];
    expect(row.frame!.c).not.toContain("line 0");
    for (const peer of [alice, bob]) expect((await peer.store.getGroups()).find(g => g.id === id)!.community!.store).toEqual([]);
    // Fifty frames of some 700 bytes were 35 KB in the record, written again for each message.
    expect(sizes.length).toBeGreaterThanOrEqual(50);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(4_000);
  });

  it("only on the newest rows: past the store, the oldest row gives its own up, after a restart too", async () => {
    const { world, peers, id } = await communityOf(["alice", "bob"]);
    const [alice, bob] = peers;
    const extra = 5;
    for (let i = 0; i < COMMUNITY_LIMITS.store + extra; i++) { await alice.groups.send(id, `line ${i}`); await world.run(200); }
    await world.run(5_000);
    const rows = said(bob, id).filter(m => m.text.startsWith("line "));
    expect(rows).toHaveLength(COMMUNITY_LIMITS.store + extra);
    expect(rows.filter(m => m.frame).map(m => m.text)).toEqual(rows.slice(extra).map(m => m.text));
    await world.restart(bob);
    await world.run(3_000);
    await alice.groups.send(id, "one more");
    await world.run(5_000);
    const after = said(bob, id).filter(m => m.frame);
    expect(after).toHaveLength(COMMUNITY_LIMITS.store);
    expect(after[0].text).toBe(`line ${extra + 1}`);
    expect(after[after.length - 1].text).toBe("one more");
  });

  it("members whose apps started again hand on what they had to one who was away", async () => {
    const { world, peers, id } = await communityOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob, carol, dave] = peers;
    await world.run(2 * 60_000);
    dave.online = false;
    await world.run(5_000);
    // Each member counts its own frames: both of them say their first, second and so on.
    for (let i = 0; i < 5; i++) { await bob.groups.send(id, `bob ${i}`); await alice.groups.send(id, `alice ${i}`); }
    await world.run(5_000);
    for (const p of [alice, bob, carol]) await world.restart(p);
    await world.run(60_000);
    await world.restart(dave);
    await world.until(() => world.texts(dave, id).filter(t => t.startsWith("bob ") || t.startsWith("alice ")).length === 10, 5 * 60_000);
    expect(world.texts(dave, id).filter(t => t.startsWith("bob "))).toEqual([0, 1, 2, 3, 4].map(i => `bob ${i}`));
    expect(world.texts(dave, id).filter(t => t.startsWith("alice "))).toEqual([0, 1, 2, 3, 4].map(i => `alice ${i}`));
  });

  it("a message deleted for everyone is not handed on, whatever its row held", async () => {
    const { world, peers, id } = await communityOf(["alice", "bob", "carol", "dave"]);
    const [alice, bob, carol, dave] = peers;
    await world.run(2 * 60_000);
    dave.online = false;
    await world.run(5_000);
    await bob.groups.send(id, "keep this");
    const { messageId } = await bob.groups.send(id, "take this back");
    await world.run(5_000);
    for (const p of [alice, bob, carol]) await deleteForEveryone(p, id, messageId!);
    await world.run(5_000);
    for (const p of [alice, bob, carol]) await world.restart(p);
    await world.run(60_000);
    await world.restart(dave);
    await world.until(() => world.texts(dave, id).includes("keep this"), 5 * 60_000);
    await world.run(10_000);
    expect(world.texts(dave, id)).not.toContain("take this back");
  });
});
