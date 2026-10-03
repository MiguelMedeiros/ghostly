import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.join, groups.community.send, groups.protocol.community-topology

/**
 * A community whose members' clocks differ. Each hub dates its entry in the beacon by its own clock, and a member
 * judged it by its own: a member whose clock was 90 s or more from the hubs' saw no hub at all (their entries looked
 * stale, or not come yet), took itself for the only hub and stayed alone, and a hub whose clock was off was no hub to
 * anyone. Seen with CLI daemons on local relays on 2026-10-02: 60 s either way worked, 90 s and 120 s never connected,
 * nothing sent or received. On headless engines (`CommunityWorld`), each ticking by its own clock.
 */
const MINUTE = 60_000;

async function community(clocks: { admin?: number; bob?: number; carol?: number }) {
  const world = new CommunityWorld(undefined, RELAY_NETWORK);
  const admin = world.add("admin", undefined, { clock: clocks.admin });
  const id = await admin.groups.create("Clocks");
  const link = await admin.groups.enableLink(id);
  await world.run(MINUTE);
  const bob = world.add("bob", undefined, { clock: clocks.bob }), carol = world.add("carol", undefined, { clock: clocks.carol });
  for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * MINUTE, 500); }
  return { world, admin, bob, carol, id };
}
const connected = (world: CommunityWorld, peer: Peer, id: string) => world.view(peer, id)!.members.some(m => !m.me && m.online);

describe("a community whose members' clocks differ by two minutes", { timeout: 120_000 }, () => {
  it.each([
    ["a member's clock two minutes ahead", { bob: 2 * MINUTE }],
    ["a member's clock two minutes behind", { bob: -2 * MINUTE }],
    ["the admin's clock two minutes ahead", { admin: 2 * MINUTE }],
    ["the admin's clock two minutes behind", { admin: -2 * MINUTE }],
  ])("%s: everyone reaches a hub, and what each says reaches the others", async (_, clocks) => {
    const { world, admin, bob, carol, id } = await community(clocks);
    const all = [admin, bob, carol];
    const took = await world.until(() => all.every(p => connected(world, p, id)), 5 * MINUTE, 1000, () => all.map(p => `${p.name} ${JSON.stringify(world.view(p, id)!.community)}`).join("; "));
    expect(took).toBeLessThanOrEqual(2 * MINUTE);
    for (const p of all) expect((await p.groups.send(id, `from ${p.name}`)).error).toBeNull();
    const said = all.map(p => `from ${p.name}`);
    await world.until(() => all.every(p => said.every(text => world.texts(p, id).includes(text))), 2 * MINUTE, 1000, () => all.map(p => `${p.name} ${JSON.stringify(world.texts(p, id))}`).join("; "));
    // It stays so: nobody ends up alone a while later.
    await world.run(5 * MINUTE);
    for (const p of all) expect(connected(world, p, id), p.name).toBe(true);
    expect(world.view(bob, id)!.members).toHaveLength(3);
    await admin.groups.send(id, "still here");
    await world.until(() => [bob, carol].every(p => world.texts(p, id).includes("still here")), MINUTE);
  });
});
