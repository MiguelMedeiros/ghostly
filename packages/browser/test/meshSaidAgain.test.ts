import { describe, expect, it } from "vitest";
import type { GroupSession } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.catch-up, groups.link.join

/**
 * A line written in a private group while its author was behind on the chain (WISP 902 § Catch-up, "Frames said
 * again"): the author's app was closed while someone was let in, and it writes the moment it opens again, before any
 * edge is up. Sealed under the epoch it last knew, the line could never reach the member let in meanwhile; found by
 * the 1.1 release-gate bug hunt (CLI daemons, a mesh of six: X never got it in 240 s). On headless engines
 * (`CommunityWorld`, simulated clock and relay budget).
 */

const allUp = (world: CommunityWorld, peers: Peer[], id: string) =>
  peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online));
/** Times each peer shows `text`, as its own history holds it. */
const copies = (world: CommunityWorld, peers: Peer[], id: string, text: string) => peers.map(p => world.texts(p, id).filter(t => t === text).length);

async function behindWhileLetIn() {
  const world = new CommunityWorld(undefined, RELAY_NETWORK);
  const [alice, bob, carol, dave, writer] = ["alice", "bob", "carol", "dave", "writer"].map(name => world.add(name));
  const first = [alice, bob, carol, dave, writer];
  const id = await alice.groups.create("Behind", "mesh");
  const link = await alice.groups.enableLink(id);
  for (const p of first.slice(1)) await p.groups.joinByLink(link);
  await world.until(() => allUp(world, first, id), 20 * 60_000);
  // The writer's app closes; someone is let in meanwhile.
  writer.online = false;
  await world.run(2_000);
  const xena = world.add("xena");
  await xena.groups.joinByLink(link);
  await world.until(() => world.member(xena, id) && world.view(alice, id)!.members.length === 6, 10 * 60_000);
  await world.run(1_000);
  // The writer's app opens again and writes at once: no edge is up, and it still believes the group is five.
  await world.restart(writer);
  expect(world.view(writer, id)!.members).toHaveLength(5);
  const sent = await writer.groups.send(id, "written while behind");
  expect(sent.error).toBeNull();
  expect(writer.groups.taken(id, sent.messageId!)).toBe(0);
  return { world, alice, bob, carol, dave, writer, xena, link, id, messageId: sent.messageId! };
}

describe("a line written while behind on a private group's chain", { timeout: 240_000 }, () => {
  it("reaches the member let in before it was written, once, and never the one let in after", async () => {
    const { world, alice, bob, carol, dave, writer, xena, link, id, messageId } = await behindWhileLetIn();
    // Someone else is let in a few seconds later, after the line.
    await world.run(4_000);
    const yann = world.add("yann");
    await yann.groups.joinByLink(link);
    const took = await world.until(() => world.texts(xena, id).includes("written while behind"), 240_000);
    expect(took).toBeLessThanOrEqual(120_000);
    const everyone = [alice, bob, carol, dave, writer, xena, yann];
    await world.until(() => world.member(yann, id) && allUp(world, everyone, id), 10 * 60_000);
    await world.run(60_000);
    // Once for everyone who was in the group when it was written, under one id (replies, edits and reactions name it).
    expect(copies(world, [alice, bob, carol, dave, writer, xena], id, "written while behind")).toEqual([1, 1, 1, 1, 1, 1]);
    for (const p of [alice, bob, carol, dave, xena]) expect(p.messages.find(m => m.text === "written while behind")!.id).toBe(messageId);
    // Never for the one let in after it: said again under an epoch before his admission.
    expect(world.texts(yann, id)).not.toContain("written while behind");
    const state = (writer.groups as unknown as { sessions: Map<string, GroupSession> }).sessions.get(id)!.state;
    const yannIn = state.chain.findIndex(c => c.k === "add" && c.s === world.view(yann, id)!.myKey);
    const said = state.sent.filter(f => f.o);
    expect(said).toHaveLength(1);
    expect(said[0].e).toBeLessThan(yannIn);
    // The group goes on as usual.
    await yann.groups.send(id, "hello all");
    await world.run(3_000);
    expect(world.texts(xena, id)).toContain("hello all");
    expect(world.texts(writer, id)).toContain("hello all");
  });
});
