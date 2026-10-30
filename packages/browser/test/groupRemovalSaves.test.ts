import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import type { Removal } from "../src/engine/removals";
// covers: groups.catch-up, groups.community.catch-up

/**
 * A group's record holds its whole state (a community's: the chain, the seen marks and a store of 256 frames). Each
 * removal taken in (delete for everyone, a catch-up hands back up to 256) and each change to my removals on their way
 * rewrote it durably: a catch-up's removals were 256 writes of a 383 KB record. They are written with one save, within
 * a second and when the app stops, as the session's own state is.
 */
async function groupOf(kind: "mesh" | "community"): Promise<{ world: CommunityWorld; alice: Peer; id: string }> {
  const world = new CommunityWorld();
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  const [alice, bob] = ["alice", "bob"].map(name => world.add(name));
  const id = kind === "mesh" ? await alice.groups.create("Gone", "mesh") : await alice.groups.create("Gone");
  await bob.groups.joinByLink(await alice.groups.enableLink(id));
  await world.until(() => world.member(bob, id), 5 * 60_000);
  await world.run(60_000);
  // What the session saves by itself within a second is written before the count starts.
  await alice.groups.flush();
  await new Promise(r => setTimeout(r, 1_100));
  return { world, alice, id };
}

const writesOf = (peer: Peer, id: string) => {
  const put = vi.spyOn(peer.store, "putGroup");
  return () => put.mock.calls.filter(([g]) => g.id === id).length;
};

describe("removals in a group", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["mesh", "community"] as const)("in a %s group: a catch-up's removals are one write of the record, kept after a restart", async (kind) => {
    const { world, alice, id } = await groupOf(kind);
    const writes = writesOf(alice, id);
    const ids = Array.from({ length: 64 }, (_, i) => `someone:${i}`);
    for (const messageId of ids) await alice.groups.removed(id, messageId);
    expect(ids.every(messageId => alice.groups.isRemoved(id, messageId))).toBe(true);
    expect(writes()).toBe(0);
    await new Promise(r => setTimeout(r, 1_100));
    expect(writes()).toBe(1);
    // Taken in just before the app stops: written as it stops.
    await alice.groups.removed(id, "someone:last");
    await world.restart(alice);
    expect([...ids, "someone:last"].every(messageId => alice.groups.isRemoved(id, messageId))).toBe(true);
  });

  it.each(["mesh", "community"] as const)("in a %s group: a removal of mine is written at once, what its sending changes with one save", async (kind) => {
    const { world, alice, id } = await groupOf(kind);
    const writes = writesOf(alice, id);
    const removal: Removal = { id: "mine:1", e: 1, at: world.now, pending: true };
    // Its row goes from the store right after: the removal is written first.
    await alice.groups.setRemovals(id, [removal]);
    expect(writes()).toBe(1);
    for (let i = 0; i < 32; i++) await alice.groups.setRemovals(id, [i % 2 ? removal : { ...removal, pending: undefined }]);
    await alice.groups.setRemovals(id, [{ ...removal, pending: undefined }]);
    expect(writes()).toBe(1);
    await world.restart(alice);
    expect(alice.groups.removals(id)).toEqual([{ ...removal, pending: undefined }]);
  });
});
