import { afterEach, describe, expect, it, vi } from "vitest";
import { pinIsNewer, type GroupPinFrame, type WirePin } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.protocol.pins

/*
 * WISP 902 § Pinned message: when k leaves the roster, each member drops the pin it shows by k, and the group has none
 * until the next one. A member away when k replaced the pin still holds the older one and says it on every edge that
 * opens: it must not come back. The host does what node.ts does: receiveGroupPin (roster, pinIsNewer, setPin, pass on
 * to the other edges) and sendGroupPinFrame when an edge opens.
 */
const sendPin = (peer: Peer, groupId: string, to: string) => {
  const pin = peer.groups.pinOf(groupId), edge = peer.host.edges(groupId).get(to);
  if (!pin?.k || !pin.sig || !edge) return;
  const frame: GroupPinFrame = { t: "group-pin", g: groupId, id: pin.id, n: pin.n, k: pin.k, sig: pin.sig };
  try { peer.host.sendOnLink(edge, frame as never); } catch { /* said when it opens */ }
};

function addPeer(world: CommunityWorld, name: string): Peer {
  return world.add(name, peer => ({
    edgeUp: (groupId: string, key: string) => sendPin(peer, groupId, key),
    groupPin: async (groupId: string, from: string, { member, pin, frame }: { member: string; pin: WirePin; frame: GroupPinFrame }) => {
      const view = peer.groups.views().find(g => g.id === groupId);
      if (!view?.myKey || view.status !== "active" || !view.members.some(m => m.key === member)) return;
      if (!pinIsNewer(peer.groups.pinOf(groupId), pin)) return;
      if (!await peer.groups.setPin(groupId, { id: pin.id, n: pin.n, by: member === view.myKey ? "me" : member, at: world.now, k: frame.k, sig: frame.sig })) return;
      for (const key of peer.host.edges(groupId).keys()) if (key !== from && key !== member) sendPin(peer, groupId, key);
    },
  }) as never);
}

async function pin(world: CommunityWorld, peer: Peer, groupId: string, id: string) {
  const wire = { id, n: Math.max(world.now, (peer.groups.pinOf(groupId)?.n ?? 0) + 1) };
  const frame = peer.groups.pinFrame(groupId, wire)!;
  await peer.groups.setPin(groupId, { ...wire, by: "me", at: world.now, k: frame.k, sig: frame.sig });
  for (const key of peer.host.edges(groupId).keys()) sendPin(peer, groupId, key);
}

describe("a private group's pin after its pinner leaves", { timeout: 300_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  for (const replaced of ["pinned", "unpinned"] as const) {
    it(`a member away while the one who left ${replaced} brings no older pin back`, async () => {
      const world = new CommunityWorld();
      vi.spyOn(Date, "now").mockImplementation(() => world.now);
      const [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map(n => addPeer(world, n));
      const id = await alice.groups.create("Trip", "mesh");
      const link = await alice.groups.enableLink(id);
      for (const p of [bob, carol, dave]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
      await world.run(60_000);
      await alice.groups.send(id, "old plan: meet at 9");
      await bob.groups.send(id, "new plan: meet at 10");
      await world.run(10_000);
      const row = (p: Peer, text: string) => p.messages.find(m => m.text === text)!.id;
      await pin(world, alice, id, row(alice, "old plan: meet at 9"));
      await world.run(10_000);
      expect(dave.groups.pinOf(id)?.id).toBeTruthy();
      // Dave goes away; Bob replaces the pin (or unpins it), then leaves the group.
      world.cut = (a, b) => a === dave || b === dave;
      await world.run(5_000);
      await pin(world, bob, id, replaced === "pinned" ? row(bob, "new plan: meet at 10") : "");
      await world.run(10_000);
      await bob.groups.leave(id);
      await world.run(30_000);
      for (const p of [alice, carol]) expect(p.groups.pinOf(id)?.id ?? "").toBe("");
      world.cut = null;
      await world.run(120_000);
      for (const p of [alice, carol]) expect(p.groups.pinOf(id)?.id ?? "").toBe("");
    });
  }
});
