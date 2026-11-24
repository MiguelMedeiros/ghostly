import { describe, expect, it } from "vitest";
import { COMMUNITY_PIN_FRAME } from "@ghostly/core";
import { pinKey } from "../src/engine/groups";
import { CommunityWorld } from "./communityWorld";
// covers: groups.pins, groups.catch-up

/**
 * The admin's pin kept past the store for whoever was away (WISP 903 § Kept past the store) is the one members show
 * live: the highest number, not the latest time. A pin numbered past the one before it can be said earlier by the
 * clock (the admin's clock ran ahead, then was set right). On headless engines (`CommunityWorld`).
 */
describe("the pin a community keeps for whoever was away", { timeout: 120_000 }, () => {
  it("is the one with the highest number, though another was said after it", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin", undefined, { staysOnline: true });
    const id = await admin.groups.create("Pins");
    const high = Date.now() + 5 * 60_000, low = high - 60_000;
    await admin.groups.sendCommunityApp(id, { t: COMMUNITY_PIN_FRAME, id: "somebody:1", n: high }, pinKey(high));
    await world.run(1_000);
    await admin.groups.sendCommunityApp(id, { t: COMMUNITY_PIN_FRAME, id: "somebody:2", n: low }, pinKey(low));
    await world.run(1_000);
    const session = admin.groups.communities.session(id)!;
    expect(session.state.lastingRank?.pin).toBe(high);
  });
});
