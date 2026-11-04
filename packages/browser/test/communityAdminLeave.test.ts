import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.leave

/**
 * agents#1664: a community admin removed the other member and left right after. Its leave counted any ready edge,
 * there the farewell edge to the member just removed, and handed the role to a member it had no edge to. The last
 * member never got the role commit nor the removal's secret: it listed the departed admin, could not write, and
 * everyone opening the link stayed "admitted".
 */
async function town(world: CommunityWorld, names: string[]): Promise<{ id: string; peers: Peer[] }> {
  const peers = names.map(n => world.add(n));
  const [admin, ...rest] = peers;
  const id = await admin.groups.create("Town");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
  await world.run(60_000);
  return { id, peers };
}
const keyOf = (p: Peer, id: string) => p.groups.communities.session(id)!.myKey;

describe("an admin who leaves a community", { timeout: 120_000 }, () => {
  it("with its only ready edge the one to a member it just removed, is refused, and the last member still can write", async () => {
    const world = new CommunityWorld();
    const { id, peers } = await town(world, ["carol", "bob", "dave"]);
    const [carol, bob, dave] = peers;
    // Carol has no way to Dave now; Bob is the one she reaches.
    world.cut = (a, b) => (a === carol && b === dave) || (a === dave && b === carol);
    await world.run(10_000);
    await carol.groups.remove(id, keyOf(bob, id));
    // Right after: the edge to Bob is still up (it carries his farewell).
    await expect(carol.groups.leave(id)).rejects.toThrow("Nobody in the group is connected right now to take your leave");
    // Still the admin, still in the group: once she reaches Dave, the role goes to someone who hears it.
    expect(world.view(carol, id)?.isAdmin).toBe(true);
    world.cut = null;
    await world.until(() => (world.view(carol, id)?.community?.connected ?? 0) > 0 && !!world.view(dave, id)?.canSend, 3 * 60_000);
    expect(await carol.groups.leave(id)).toBe(keyOf(dave, id));
    await world.until(() => !!world.view(dave, id)?.isAdmin, 3 * 60_000);
    expect(world.view(dave, id)?.canSend).toBe(true);
  });
});
