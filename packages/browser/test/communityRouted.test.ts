import { describe, expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import { CommunityWorld } from "./communityWorld";
// covers: groups.community.send, groups.protocol.community-topology

/**
 * What a hub routes for another member (`group-secret`, `group-entry` addressed to someone else): only one of this
 * group's, for a key its roster names, in a real frame's shape; what it remembers and hands on is that frame rebuilt.
 */
describe("a hub routing frames for other members", { timeout: 120_000 }, () => {
  it("routes a real-shaped frame for a member, rebuilt; a made-up one is neither handed on nor remembered", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const id = await admin.groups.create("Routes");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, carol]) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => [bob, carol].every(p => world.member(p, id)), 10 * 60_000);
    await world.run(20_000);
    const everyone = [admin, bob, carol];
    const hub = everyone.find(p => p.groups.communities.isHub(id))!;
    expect(hub).toBeDefined();
    const [from, to] = everyone.filter(p => p !== hub).map(p => world.view(p, id)!.myKey!);
    const relayed = (hub.groups.communities as unknown as { live: Map<string, { relayed: Set<string> }> }).live.get(id)!.relayed;
    const routed: Record<string, unknown>[] = [];
    world.drop = (sender, _to, frame) => {
      if (sender !== hub || (frame.t !== "group-secret" && frame.t !== "group-entry")) return false;
      routed.push(frame);
      return true;
    };
    const s = { e: "AAAA", n: "BBBB", c: "CCCC" };
    const kept = relayed.size;
    const bad: Record<string, unknown>[] = [
      // A key nobody in the group holds.
      { t: "group-secret", v: 2, g: id, to: createIdentity().pubKeyZ32, h: "a".repeat(64), s },
      // Not a key at all.
      { t: "group-secret", v: 2, g: id, to: "x".repeat(60_000), h: "a".repeat(64), s },
      // A member's, with a hash far past a commit hash's size, or none.
      { t: "group-secret", v: 2, g: id, to, h: "y".repeat(60_000), s },
      { t: "group-secret", v: 2, g: id, to, s },
      { t: "group-entry", v: 2, g: id, to, x: "z".repeat(60_000), s },
      // No sealed secret, or another group's.
      { t: "group-secret", v: 2, g: id, to, h: "b".repeat(64), s: "w".repeat(60_000) },
      { t: "group-secret", v: 2, g: "A".repeat(22), to, h: "c".repeat(64), s },
    ];
    for (const frame of bad) await hub.groups.handleEdgeFrame(id, from, frame);
    await world.run(1_000);
    expect(routed).toEqual([]);
    expect(relayed.size).toBe(kept);

    // A real one is routed, without what was added to it.
    await hub.groups.handleEdgeFrame(id, from, { t: "group-secret", v: 2, g: id, to, h: "d".repeat(64), s: { ...s, pad: "p".repeat(1000) }, pad: "q".repeat(60_000) });
    await world.run(1_000);
    expect(routed.length).toBeGreaterThan(0);
    for (const frame of routed) expect(frame).toEqual({ t: "group-secret", v: 2, g: id, to, h: "d".repeat(64), s });
    expect(relayed.size).toBe(kept + 1);
  });
});
