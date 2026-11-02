import { describe, expect, it } from "vitest";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * The world's `linkBack` says what the engine's does (`node.ts`): the other end of a link that was up once in this run
 * is back. A link opened again after the old one closed was never up, and is not back until it comes up, whether the
 * world models the relays or not. The world said so of any link whose other app ran, so a hub the engine takes for dead
 * (`hubDead`) was alive in the world, and an open/close loop of the admin's edge to a hub back from away did not show
 * (bug hunt, 2026-11-02).
 */
describe("the test world's linkBack", { timeout: 60_000 }, () => {
  for (const network of [null, RELAY_NETWORK]) {
    it(`is the engine's: only a link that was up once is back (${network ? "relays" : "no network model"})`, async () => {
      const world = new CommunityWorld(undefined, null);
      const alice = world.add("alice"), bob = world.add("bob");
      const id = await alice.groups.create("Open door");
      const link = await alice.groups.enableLink(id);
      await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
      await world.until(() => world.member(bob, id), 5 * 60_000);
      // The groups come up with no model, then (for the second run) the relays' pace, as the hub-restart tests do.
      (world as unknown as { network: typeof RELAY_NETWORK | null }).network = network;
      await world.run(60_000);
      const state = alice.groups.communities.session(id)!.state, bobKey = bob.groups.communities.session(id)!.myKey;
      const edgeTo = (p: Peer, key: string) => [...p.links].find(([, e]) => e.kind === "edge" && e.peer === key)?.[0];
      const up = edgeTo(alice, bobKey)!;
      expect(alice.host.linkReady(up, 2)).toBe(true);
      expect(alice.host.linkBack!(up)).toBe(true);

      // Cut off from bob, alice closes her edge and opens it again: bob's app runs, but the new link was never up.
      world.cut = (a, b) => (a === alice && b === bob) || (a === bob && b === alice);
      await alice.host.closeEdge(up);
      const again = await alice.host.openEdge(state, bobKey);
      expect(alice.host.linkReady(again, 2)).toBe(false);
      expect(alice.host.linkBack!(again)).toBe(false);
      await world.run(10_000);
      expect(alice.host.linkBack!(again)).toBe(false);
    });
  }
});
