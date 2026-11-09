import { afterEach, describe, expect, it, vi } from "vitest";
import { identityFromSeedB64 } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * A group's link opened twice before the first open returns (tapped twice, or the join card and a paste in New chat).
 * Each open drew its own member key, and the engine keys an entry session by it: two guest sessions, and the one whose
 * write of `joining` lost stayed open until the app restarted, polling the link host's record all along.
 */
describe("a group's link opened twice at once", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // As `node.ts` does: an entry session's id comes from the member key, not from the peer and role (the World's own).
  const keyedByMember = (peer: Peer) => {
    const opened = new Set<string>(), open = peer.host.openEntry.bind(peer.host);
    peer.host.openEntry = async (link, role, seedB64, other) => {
      const id = `entry:${peer.name}:${link.g}:${identityFromSeedB64(seedB64).pubKeyZ32}:${role}`;
      opened.add(id);
      if (peer.links.has(id)) return id;
      // The World's session, moved under the member key's id before another open can find it under its own.
      const shared = `entry:${peer.name}:${link.g}:${other}:${role}`;
      void open(link, role, seedB64, other);
      peer.links.set(id, peer.links.get(shared)!);
      peer.links.delete(shared);
      return id;
    };
    return opened;
  };

  for (const kind of ["community", "mesh"] as const) {
    it(`${kind}: opens one entry session, and none stays open once in`, async () => {
      const world = new CommunityWorld();
      vi.spyOn(Date, "now").mockImplementation(() => world.now);
      const admin = world.add("admin");
      const id = kind === "community" ? await admin.groups.create("Door") : await admin.groups.create("Door", "mesh");
      const link = await admin.groups.enableLink(id);
      const bob = world.add("bob"), opened = keyedByMember(bob);
      const both = await Promise.all([bob.groups.joinByLink(link), bob.groups.joinByLink(link)]);
      expect(both).toEqual([id, id]);
      await world.until(() => world.member(bob, id), 3 * 60_000);
      await world.run(10 * 60_000);
      const entries = [...bob.links.values()].filter(e => e.g === id && e.kind !== "edge");
      console.log(`${kind} DOUBLE OPEN: ${opened.size} entry sessions opened, ${entries.length} still open 10 min after the join`);
      expect(opened.size, "entry sessions opened").toBe(1);
      expect(entries, "entry sessions still open").toEqual([]);
    });
  }
});
