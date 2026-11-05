import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.leave, groups.community.leave

/**
 * A member who leaves on their own is said to have left; one the admin removes, no longer a member (in a private group,
 * removed by the admin who signed the commit). Both apps know which it was: a community's commit says `leave` or
 * `remove`, a private group's remove carries the admin's `left` mark.
 */
async function group(mode: "mesh" | "community"): Promise<{ world: CommunityWorld; id: string; alice: Peer; bob: Peer; carol: Peer; dave: Peer }> {
  const world = mode === "mesh" ? new CommunityWorld(undefined, null) : new CommunityWorld();
  const peers = ["alice", "bob", "carol", "dave"].map(n => world.add(n));
  const [alice, bob, carol, dave] = peers;
  const id = mode === "mesh" ? await alice.groups.create("Turns", mode) : await alice.groups.create("Turns");
  const link = await alice.groups.enableLink(id);
  if (mode === "mesh") {
    for (const p of peers.slice(1)) await p.groups.joinByLink(link);
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === 4), 20 * 60_000);
  } else {
    for (const p of peers.slice(1)) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => peers.every(p => world.member(p, id)), 20 * 60_000);
  }
  await world.run(20_000);
  return { world, id, alice, bob, carol, dave };
}

const lines = (p: Peer, id: string, member: string) =>
  p.messages.filter(m => m.linkId === `group:${id}` && m.member === member && (m.event === "gone" || m.event === "left")).map(m => `${m.event}: ${m.text}`);

describe("the line a member's leaving or removal leaves", { timeout: 300_000 }, () => {
  for (const mode of ["mesh", "community"] as const) {
    it(`${mode}: "Bob left" for a leave, ${mode === "mesh" ? '"Alice removed Dave"' : '"Dave is no longer a member"'} for a removal`, async () => {
      const { world, id, alice, bob, carol, dave } = await group(mode);
      const bobKey = world.view(bob, id)!.myKey!, daveKey = world.view(dave, id)!.myKey!;
      await bob.groups.leave(id);
      await world.until(() => !world.view(carol, id)?.members.some(m => m.key === bobKey), 2 * 60_000);
      await world.run(5_000);
      // No edge here says a name: a private group's members know each other's from their name records (WISP 902 § Messages).
      const bobName = mode === "mesh" ? "bob" : `Member ${bobKey.slice(0, 8)}`;
      for (const p of [alice, carol]) expect(lines(p, id, bobKey)).toEqual([`left: ${bobName} left`]);
      await alice.groups.remove(id, daveKey);
      await world.until(() => !world.view(carol, id)?.members.some(m => m.key === daveKey), 2 * 60_000);
      await world.run(5_000);
      if (mode === "community") {
        for (const p of [alice, carol]) expect(lines(p, id, daveKey)).toEqual([`gone: Member ${daveKey.slice(0, 8)} is no longer a member`]);
        return;
      }
      // A private group's line names the admin who removed them, as a rename or a picture change does; theirs in their words.
      const aliceKey = world.view(alice, id)!.myKey!;
      expect(lines(alice, id, daveKey)).toEqual(["gone: You removed dave"]);
      expect(lines(carol, id, daveKey)).toEqual(["gone: alice removed dave"]);
      for (const p of [alice, carol]) expect(p.messages.find(m => m.event === "gone" && m.member === daveKey)?.by).toBe(aliceKey);
    });
  }
});
