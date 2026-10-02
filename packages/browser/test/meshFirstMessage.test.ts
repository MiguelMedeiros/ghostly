import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.catch-up, groups.link.join

/**
 * Two people open a private group's link at the same moment, and the first one let in writes at once: the group has
 * two members for it, no edge is up yet, and by the time its edge to the admin opens the admin has admitted the other
 * (it is an epoch ahead). Measured on the real network on 2026-10-02: that first message never reached the admin.
 * On headless engines (`CommunityWorld`, simulated clock and relay budget).
 */
async function twoJoinAtOnce() {
  const world = new CommunityWorld(undefined, RELAY_NETWORK);
  const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
  const id = await alice.groups.create("First", "mesh");
  const link = await alice.groups.enableLink(id);
  await bob.groups.joinByLink(link);
  await carol.groups.joinByLink(link);
  await world.until(() => world.member(bob, id) || world.member(carol, id), 10 * 60_000);
  const [first, second] = world.member(bob, id) ? [bob, carol] : [carol, bob];
  // In, with the admin alone, and no edge yet.
  const view = world.view(first, id)!;
  expect(view.members).toHaveLength(2);
  expect(view.members.filter(m => m.key !== view.myKey && m.online)).toHaveLength(0);
  return { world, alice, first, second, id };
}
/** `group-msg` frames that reached `to`, by author key. */
function arrivals(world: CommunityWorld, to: Peer): string[] {
  const authors: string[] = [];
  world.drop = (_from, target, frame) => { if (target === to && frame.t === "group-msg") authors.push(String(frame.s)); return false; };
  return authors;
}
const everyoneUp = (world: CommunityWorld, peers: Peer[], id: string) => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online));

describe("a joiner's first message, sent before any edge is up", { timeout: 120_000 }, () => {
  it("reaches the admin once its edge opens, though the admin admitted someone else meanwhile", async () => {
    const { world, alice, first, second, id } = await twoJoinAtOnce();
    const toAlice = arrivals(world, alice);
    const sent = await first.groups.send(id, "first words");
    expect(sent.error).toBeNull();
    await first.groups.send(id, "and more");
    // No edge took it yet: `group send --wait sent` keeps waiting.
    expect(first.groups.taken(id, sent.messageId!)).toBe(0);
    const took = await world.until(() => world.texts(alice, id).includes("and more"), 2 * 60_000);
    expect(took).toBeLessThanOrEqual(60_000);
    expect(world.texts(alice, id)).toEqual(["first words", "and more"]);
    expect(first.groups.taken(id, sent.messageId!)).toBeGreaterThanOrEqual(1);
    // Everyone connected, and a while later: still once, and never for the one admitted after it.
    await world.until(() => everyoneUp(world, [alice, first, second], id), 10 * 60_000);
    await world.run(3 * 60_000);
    expect(world.texts(alice, id)).toEqual(["first words", "and more"]);
    expect(toAlice.filter(s => s === world.view(first, id)!.myKey)).toHaveLength(2);
    expect(world.texts(second, id)).toEqual([]);
    await second.groups.send(id, "hello from the second");
    await world.run(2_000);
    expect(world.texts(alice, id)).toEqual(["first words", "and more", "hello from the second"]);
    expect(world.texts(first, id)).toContain("hello from the second");
  });

  it("still goes when the sender's app restarts before any edge took it", async () => {
    const { world, alice, first, id } = await twoJoinAtOnce();
    expect((await first.groups.send(id, "before the restart")).error).toBeNull();
    await world.restart(first);
    const took = await world.until(() => world.texts(alice, id).includes("before the restart"), 5 * 60_000);
    expect(took).toBeLessThanOrEqual(2 * 60_000);
    await world.run(2 * 60_000);
    expect(world.texts(alice, id)).toEqual(["before the restart"]);
  });
});
