import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.catch-up

/**
 * A member back from away reads each line of the group's history ("… joined", "… is no longer a member") among the
 * messages of its moment, as the members who were there read it: below what was written before the change, above what
 * was written after it. The catch-up brings the change (its commit) before the messages written under the epoch before.
 */

const ROW = (m: { event?: string; text: string }) => m.event ? `[${m.event}]` : m.text;
/** The rows each member holds now: what comes after them is what the test reads. */
const mark = (peers: Peer[]) => new Map(peers.map(p => [p, p.messages.length]));
/** The history as a member reads it, lines and messages, from these texts and lines only, since `from` was marked. */
function history(peer: Peer, id: string, keep: readonly string[], from: Map<Peer, number>): string[] {
  return peer.messages.slice(from.get(peer)).filter(m => m.linkId === `group:${id}`).map(ROW).filter(row => keep.includes(row));
}

async function groupOf(profile: "mesh" | "community", names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string; link: string }> {
  const world = new CommunityWorld(undefined, null);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Turns", profile);
  const link = `https://app.ghostly.tools/#/join/${await admin.groups.enableLink(id)}`;
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length), 20 * 60_000, 1000);
  await world.run(20_000);
  return { world, peers, id, link };
}

async function say(world: CommunityWorld, peer: Peer, id: string, text: string): Promise<void> {
  await peer.groups.send(id, text);
  await world.run(2_000);
}

describe("a member back from away reads the group's lines among the messages of their moment", { timeout: 180_000 }, () => {
  for (const profile of ["mesh", "community"] as const) {
    it(`${profile}: a member's goodbye, then "no longer a member", then the answer to it`, async () => {
      const { world, peers, id } = await groupOf(profile, ["alice", "bob", "carol", "dave"]);
      const [alice, bob, carol, dave] = peers;
      dave.online = false;
      await world.run(5_000);
      const from = mark(peers);
      await say(world, bob, id, "thanks all");
      await say(world, bob, id, "I'm off, bye");
      await bob.groups.leave(id);
      await world.until(() => world.view(carol, id)?.members.length === 3, 5 * 60_000);
      await world.run(5_000);
      await say(world, alice, id, "bye Bob");
      const keep = ["thanks all", "I'm off, bye", "[gone]", "bye Bob"];
      expect(history(carol, id, keep, from)).toEqual(keep);
      world.reopen(dave);
      await world.until(() => history(dave, id, keep, from).length === keep.length, 5 * 60_000);
      await world.run(30_000);
      expect(history(dave, id, keep, from)).toEqual(keep);
    });
  }

  for (const profile of ["mesh", "community"] as const) it(`${profile}: someone let in while a member was away sits between the question and the welcome`, async () => {
    const { world, peers, id, link } = await groupOf(profile, ["alice", "bob", "carol", "dave"]);
    const [alice, bob, carol, dave] = peers;
    dave.online = false;
    await world.run(5_000);
    const from = mark(peers);
    await say(world, bob, id, "who else is coming?");
    const erin = world.add("erin");
    await erin.groups.joinByLink(link);
    await world.until(() => world.member(erin, id) && world.view(carol, id)?.members.length === 5, 10 * 60_000);
    await world.run(5_000);
    await say(world, alice, id, "welcome Erin");
    const keep = ["who else is coming?", "[joined]", "welcome Erin"];
    expect(history(carol, id, keep, from)).toEqual(keep);
    world.reopen(dave);
    await world.until(() => history(dave, id, keep, from).length === keep.length, 5 * 60_000);
    await world.run(30_000);
    expect(history(dave, id, keep, from)).toEqual(keep);
  });
});
