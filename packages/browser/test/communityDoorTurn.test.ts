import { describe, expect, it } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: devices.turn.limited, groups.community.join

/*
 * Door duty needs a good turn read under 60 seconds old (WISP 06 § When a device checks): a hub on a device that cannot
 * confirm it is the active one opens no entry session for a knock (the admission would be a commit that may fork the
 * group). It asks for a read without waiting, and answers at the door's next turn once one says it is the active one.
 */
describe("a community's door on a device that cannot confirm its turn", { timeout: 120_000 }, () => {
  it("lets nobody in while the read is not good, asks for one without waiting, and lets them in once it is", async () => {
    const world = new CommunityWorld();
    let confirmed = true;
    const asks: (boolean | undefined)[] = [];
    const admin = world.add("admin", () => ({ adminTurn: async (_groupId: string, options?: { wait?: boolean }) => { asks.push(options?.wait); return confirmed; } }));
    const id = await admin.groups.create("Door");
    const link = await admin.groups.enableLink(id);
    await world.run(30_000);
    confirmed = false;
    asks.length = 0;
    const bob = world.add("bob");
    await bob.groups.joinByLink(link);
    await world.run(3 * 60_000);
    expect(world.member(bob, id)).toBe(false);
    expect(world.view(admin, id)!.members).toHaveLength(1);
    // The door asked, and never waited for the answer inside its tick.
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((wait) => wait === false)).toBe(true);
    confirmed = true;
    await world.until(() => world.member(bob, id), 5 * 60_000, 500);
    expect(world.view(admin, id)!.members).toHaveLength(2);
  });
});
