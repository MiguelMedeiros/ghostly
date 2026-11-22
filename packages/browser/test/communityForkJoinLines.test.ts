import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * A community forks: the admin, cut off, hands the role on while a hub on the other side lets a joiner in. The role's
 * branch wins, the joiner's admission is dropped and it is let in again on top. Members who had taken the dropped
 * admission read "<joiner> is no longer a member" for someone who never left, then a second "joined"; those on the
 * winning side one "joined". Every member ends with the same single line.
 */
describe("a joiner whose admission lost a fork and was let in again", { timeout: 300_000 }, () => {
  it("leaves one \"joined\" line and no \"is no longer a member\" line in every member's history", async () => {
    const world = new CommunityWorld();
    const [admin, bob, carol] = ["admin", "bob", "carol"].map(n => world.add(n));
    const id = await admin.groups.create("Fork");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    await world.until(() => bob.groups.communities.isHub(id), 5 * 60_000);
    await world.run(60_000);
    const carolKey = world.view(carol, id)!.myKey!;
    // The admin is cut off and hands the role to Carol; on the other side Bob lets a joiner in.
    world.part = (p: Peer) => p === admin ? 0 : 1;
    await world.run(60_000);
    await admin.groups.makeAdmin(id, carolKey);
    const joiner = world.add("joiner");
    await joiner.groups.joinByLink(link);
    await world.until(() => world.view(carol, id)?.members.length === 4 && world.view(bob, id)?.members.length === 4, 5 * 60_000);
    const joinerKey = world.view(carol, id)!.members.find(m => ![carolKey, world.view(bob, id)!.myKey, world.view(admin, id)!.myKey].includes(m.key))!.key;
    // The network heals: the role's branch wins and the joiner is let in again.
    world.part = null;
    await world.until(() => [admin, bob, carol, joiner].every(p => world.view(p, id)?.members.length === 4 && world.member(p, id)) && !!world.view(carol, id)?.isAdmin, 10 * 60_000);
    await world.run(60_000);
    for (const p of [admin, bob, carol]) {
      const lines = p.messages.filter(m => m.linkId === `group:${id}` && m.member === joinerKey && (m.event === "joined" || m.event === "gone" || m.event === "left")).map(m => m.event);
      expect(lines, p.name).toEqual(["joined"]);
    }
  });
});
