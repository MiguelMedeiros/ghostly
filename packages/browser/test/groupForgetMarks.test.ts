import { afterEach, describe, expect, it } from "vitest";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.forget, groups.leave, groups.remove-member

/**
 * A group deleted here after its admin removed me kept its unread, "@" and list time in the engine (only Leave dropped
 * them): joining it again by its link in the same app run showed an unread "@" for a line no longer in its history,
 * and the app's badge counted it, as the app forgets its read mark with the group. Every way the history goes, the
 * marks go with it.
 */
describe("the marks of a group whose history went from this device", { timeout: 300_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  async function group(seed: number, kind: "mesh" | "community") {
    const world = new CommunityWorld(undefined, null, seededRandom(seed));
    restore = sameRun(world, seed);
    const peers = ["admin", "bob", "carol"].map(n => world.add(n));
    const [admin, bob, carol] = peers;
    const id = kind === "mesh" ? await admin.groups.create("Marks", "mesh") : await admin.groups.create("Marks");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    await world.until(() => peers.every(p => world.view(p, id)?.members.length === 3), 2 * 60_000);
    await world.run(20_000);
    // Bob names carol; carol does not open the group.
    const carolKey = world.view(carol, id)!.myKey!;
    await bob.groups.send(id, "@carol look", [{ k: carolKey, o: 0, l: 6 }]);
    await world.until(() => world.texts(carol, id).includes("@carol look"), 5 * 60_000);
    expect(world.view(carol, id)!.lastMentionAt).toBeGreaterThan(0);
    return { world, id, link, admin, carol, carolKey };
  }

  /** Ten minutes on, carol joins by the link again: a fresh membership with an empty history and no marks. */
  async function rejoined(world: CommunityWorld, carol: Peer, id: string, link: string) {
    await world.run(10 * 60_000);
    await carol.groups.joinByLink(link);
    await world.until(() => world.member(carol, id), 5 * 60_000);
    const view = world.view(carol, id)!;
    expect(world.texts(carol, id)).toEqual([]);
    expect(view.lastMentionAt ?? 0, "a mention kept from the deleted history").toBe(0);
    expect(view.lastPeerMessageAt ?? 0, "an unread kept from the deleted history").toBe(0);
    expect(view.lastMessageAt ?? 0, "a list time kept from the deleted history").toBe(0);
  }

  for (const seed of [11, 22, 33]) {
    it(`seed ${seed}: removed, then deleted here: a join by the link starts with no unread or "@"`, async () => {
      const { world, id, link, admin, carol, carolKey } = await group(seed, "mesh");
      await admin.groups.remove(id, carolKey);
      await world.until(() => world.view(carol, id)?.status === "removed", 5 * 60_000);
      await carol.groups.forget(id);
      expect(world.view(carol, id)).toBeUndefined();
      await rejoined(world, carol, id, link);
    });
  }

  it("control: left, then a join by the link starts with no unread or \"@\"", async () => {
    const { world, id, link, carol } = await group(11, "mesh");
    await carol.groups.leave(id);
    expect(world.view(carol, id)).toBeUndefined();
    await rejoined(world, carol, id, link);
  });

  it("a community deleted here: a join by the link starts with no unread or \"@\"", async () => {
    const { world, id, link, carol } = await group(11, "community");
    await carol.groups.forget(id);
    expect(world.view(carol, id)).toBeUndefined();
    await rejoined(world, carol, id, link);
  });
});
