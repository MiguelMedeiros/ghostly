import { describe, expect, it } from "vitest";
import { createIdentity, lobbyKeys, lobbyRecords } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.community-topology

/**
 * A hub reads its lobby every half minute while nobody new asks there, every 6 s for a while after someone did. The
 * relays' budget may hold its read back: the relay client then answers the packet it already knew, with only
 * `readHeldBackFor` to say so. Taken for a reading, the request that came meanwhile waited for the hub's next turn: the
 * members of a hub that closed, asking a hub left, were cut off up to 40 s more (CLI daemons, 2026-10-20: a hub's reads
 * at 43.8, 49.8, 55.8 and 61.8 s all answered its lobby as it was at 22 s). It reads again when the hold ends.
 */
const session = (peer: Peer, id: string) => peer.groups.communities.session(id)!;
const keyOf = (peer: Peer, id: string) => session(peer, id).myKey;
const edgeTo = (peer: Peer, key: string) => [...peer.links.values()].find(e => e.kind === "edge" && e.peer === key);

describe("a hub whose read of its own lobby the relays held back", { timeout: 120_000 }, () => {
  it("reads it again when the hold ends, not at its next turn", async () => {
    const world = new CommunityWorld();
    world.heldReads = true;
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const id = await admin.groups.create("Lobby");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
    // Long enough after the joins that the hub reads its lobby at the idle pace.
    await world.run(3 * 60_000);
    const hub = [admin, bob, carol].find(p => p.groups.communities.isHub(id) && [...p.links.values()].some(e => e.kind === "edge"))!;
    expect(hub).toBeDefined();
    const lobby = lobbyKeys(session(hub, id).state.rv, id, keyOf(hub, id));

    // Someone asks; the hub's next read of its lobby is held back (once), and answers the lobby it knew.
    const key = createIdentity().pubKeyZ32;
    let heldAt: number | undefined;
    world.holdRead = (peer, k) => {
      if (peer !== hub || k !== lobby.identity.pubKeyZ32 || heldAt !== undefined) return false;
      heldAt = world.now;
      return true;
    };
    world.pkarr.set(lobby.identity.pubKeyZ32, lobbyRecords(lobby, [{ key, ts: world.now }]));
    await world.until(() => heldAt !== undefined, 60_000);
    const seen = await world.until(() => !!edgeTo(hub, key), 60_000);
    // The hold (5 s here) and a tick. Before: the next read was the hub's next turn, 30 s after the held one.
    expect(seen).toBeLessThanOrEqual(10_000);
  });
});
