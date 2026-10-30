import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_GOSSIP_MS } from "../src/engine/groups";
// covers: groups.catch-up, groups.community.catch-up

/**
 * agents#1645, #1646. WISP 400 § Delete for everyone: a tombstone "does not ring, count as unread or move the chat",
 * and keeps no mention. A member's line deleted for everyone kept the group unread with its "@" (after a restart too),
 * a copy refused for one gave a member who was away a fresh "@" for a line it never sees, and its pin stayed.
 */
async function groupOf(kind: "mesh" | "community", names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld();
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = kind === "mesh" ? await admin.groups.create("Gone", "mesh") : await admin.groups.create("Gone");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
  const peers = [admin, ...rest];
  // The engine refuses a copy of a line deleted for everyone (`storeNewMessage`): the world's store, as it does.
  for (const p of peers) {
    const store = p.host.storeMessage.bind(p.host);
    p.host.storeMessage = async (message, live, place) => p.groups.isRemoved(id, message.id) ? false : store(message, live, place);
  }
  await world.run(60_000);
  return { world, peers, id };
}

/** What the engine does with a line its author deleted for everyone (`forgetGroupMessage`): noted, the row gone, the marks back. */
async function deleteForEveryone(peer: Peer, id: string, messageId: string): Promise<void> {
  const row = peer.messages.find(m => m.id === messageId)!;
  await peer.groups.removed(id, messageId);
  peer.messages.splice(peer.messages.indexOf(row), 1);
  await peer.groups.unmark(id, row);
}

const marks = (world: CommunityWorld, peer: Peer, id: string) => {
  const view = world.view(peer, id)!;
  return { lastMessageAt: view.lastMessageAt, lastPeerMessageAt: view.lastPeerMessageAt, lastMentionAt: view.lastMentionAt };
};

describe("a group line deleted for everyone", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["mesh", "community"] as const)("in a %s group: unread, \"@\" and the list's place go back, after a restart too", async (kind) => {
    const { world, peers, id } = await groupOf(kind, ["alice", "bob"]);
    const [alice, bob] = peers;
    const aliceKey = world.view(alice, id)!.myKey!;
    await bob.groups.send(id, "bob earlier line");
    await bob.groups.send(id, "@alice an earlier mention", [{ k: aliceKey, o: 0, l: 6 }]);
    await world.until(() => world.texts(alice, id).includes("@alice an earlier mention"), MESH_GOSSIP_MS + 60_000);
    await world.run(5_000);
    // Alice reads the group now.
    const readAt = world.now;
    const before = marks(world, alice, id);
    await world.run(5_000);
    const { messageId } = await bob.groups.send(id, "@alice the secret plan", [{ k: aliceKey, o: 0, l: 6 }]);
    await world.until(() => world.texts(alice, id).includes("@alice the secret plan"), MESH_GOSSIP_MS + 60_000);
    expect(world.view(alice, id)!.lastMentionAt).toBeGreaterThan(readAt);
    await deleteForEveryone(alice, id, messageId!);
    const after = marks(world, alice, id);
    console.log(`DELETED ${kind}: before ${JSON.stringify(before)} after ${JSON.stringify(after)} read at ${readAt}`);
    for (const mark of [after.lastPeerMessageAt, after.lastMentionAt, after.lastMessageAt]) expect(mark).toBeLessThanOrEqual(readAt);
    expect(after.lastMentionAt).toBeDefined();
    await new Promise(r => setTimeout(r, 1_100));
    await world.restart(alice);
    const restarted = marks(world, alice, id);
    for (const mark of [restarted.lastPeerMessageAt, restarted.lastMentionAt, restarted.lastMessageAt]) expect(mark).toBeLessThanOrEqual(readAt);
  });

  it("a member away while it was written and deleted gets no \"@\" from the copy refused when it comes", async () => {
    const { world, peers, id } = await groupOf("mesh", ["alice", "bob", "dave"]);
    const [, bob, dave] = peers;
    const daveKey = world.view(dave, id)!.myKey!;
    expect(world.view(dave, id)!.lastMentionAt).toBeUndefined();
    world.cut = (a, b) => a === dave || b === dave;
    await world.run(3_000);
    const { messageId } = await bob.groups.send(id, "@dave away secret", [{ k: daveKey, o: 0, l: 5 }]);
    await world.run(5_000);
    // The deletion reaches Dave first (noted also when the message is not here yet), then the members' copy.
    await dave.groups.removed(id, messageId!);
    world.cut = null;
    await world.run(MESH_GOSSIP_MS + 30_000);
    expect(world.texts(dave, id)).not.toContain("@dave away secret");
    expect(world.view(dave, id)!.lastMentionAt).toBeUndefined();
  });

  it("its pin goes with it, and the same pin said again does not bring it back", async () => {
    const { world, peers, id } = await groupOf("mesh", ["alice", "bob"]);
    const [alice, bob] = peers;
    const bobKey = world.view(bob, id)!.myKey!;
    const { messageId } = await bob.groups.send(id, "pinned then deleted");
    await world.until(() => world.texts(alice, id).includes("pinned then deleted"), MESH_GOSSIP_MS + 60_000);
    const pin = { id: messageId!, n: 1, by: bobKey, at: world.now, messageId: messageId! };
    expect(await alice.groups.setPin(id, pin)).toBe(true);
    expect(world.view(alice, id)!.pin?.id).toBe(messageId);
    await deleteForEveryone(alice, id, messageId!);
    expect(world.view(alice, id)!.pin?.id ?? "").toBe("");
    expect(await alice.groups.setPin(id, pin)).toBe(false);
    expect(world.view(alice, id)!.pin?.id ?? "").toBe("");
  });
});
