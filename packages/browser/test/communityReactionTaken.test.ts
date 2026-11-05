import { describe, expect, it } from "vitest";
import { COMMUNITY_REACTION_FRAME } from "@ghostly/core";
import { reactionKey } from "../src/engine/groups";
import { CommunityWorld, RELAY_NETWORK } from "./communityWorld";
// covers: groups.protocol.reactions, groups.community.send

/**
 * A reaction in a community rides in an application frame of its own: what takes that frame takes the reaction, as for
 * an edit, and `group react --wait sent` waits on it (`groupTaken` with the reaction's number). On headless engines
 * (`CommunityWorld`, simulated clock and relay budget).
 */
describe("my reaction in a community", { timeout: 120_000 }, () => {
  it("counts as taken once the frame carrying it went out on an edge, and not before", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const admin = world.add("admin", undefined, { staysOnline: true });
    const id = await admin.groups.create("Reacts");
    const link = await admin.groups.enableLink(id);
    await world.run(30_000);
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 5 * 60_000, 500);
    // Apart from everyone: the frame is kept, and nobody took it.
    let apart = true;
    world.cut = (a, b) => apart && (a === bob || b === bob);
    const n = 7;
    await bob.groups.sendCommunityApp(id, { t: COMMUNITY_REACTION_FRAME, id: "somebody:1", e: "👍", n }, reactionKey(n));
    await world.run(5_000);
    expect(bob.groups.taken(id, "somebody:1", undefined, n)).toBe(0);
    // An edge opens: the frame goes out, and the reaction with it. Another number is not taken.
    apart = false;
    await world.until(() => bob.groups.taken(id, "somebody:1", undefined, n) > 0, 5 * 60_000);
    expect(bob.groups.taken(id, "somebody:1", undefined, n + 1)).toBe(0);
  });
});
