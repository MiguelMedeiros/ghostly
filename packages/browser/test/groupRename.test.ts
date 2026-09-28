import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { Groups, type GroupsHost } from "../src/engine/groups";
// covers: groups.rename

/**
 * A group's name (WISP 9xx § Metadata) through the real community engine on headless peers: the admin
 * renames it beside the picture, members get it through the hubs, someone let in by a member while the
 * admin is away is told it by the welcome and gets the statement at their first sync, and each rename
 * leaves a line. The mesh profile's engine path is in `groups.test.ts`.
 */
const PIC = "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0x00, 0x02, 1, 0xff, 0xd9));

const renameLines = (peer: Peer, id: string) => peer.messages.filter(m => m.linkId === `group:${id}` && m.event === "renamed").map(m => m.text);

describe("group name on headless community engines", { timeout: 120_000 }, () => {
  it("renamed by the admin, the picture kept, seen by everyone and by someone let in later; a member cannot", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), others = ["bob", "carol", "dave"].map(name => world.add(name));
    const id = await alice.groups.create("Plaza");
    const link = await alice.groups.enableLink(id);
    for (const p of others) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => others.every(p => world.member(p, id)), 10 * 60_000);
    await world.run(20_000);

    await alice.groups.setPicture(id, PIC);
    await expect(others[0].groups.rename(id, "Bob's")).rejects.toThrow("Only the admin");
    await expect(alice.groups.rename(id, " \n ")).rejects.toThrow("1 to 64 characters");
    await alice.groups.rename(id, "Town\nsquare");
    expect(world.view(alice, id)?.name).toBe("Town square");
    await world.until(() => others.every(p => world.view(p, id)?.name === "Town square" && world.view(p, id)?.picture === PIC), 60_000);
    expect(renameLines(alice, id)).toEqual(["You renamed the group to “Town square”"]);
    for (const p of others) expect(renameLines(p, id)).toHaveLength(1);

    // The admin goes away; Erin joins by the link, let in by a member, and sees the new name.
    alice.online = false;
    const erin = world.add("erin");
    await erin.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(erin, id), 10 * 60_000);
    await world.until(() => world.view(erin, id)?.name === "Town square" && world.view(erin, id)?.picture === PIC, 3 * 60_000);

    // Back, the admin removes the picture: the name stays, and a restart keeps it.
    alice.online = true;
    await world.run(15_000);
    await alice.groups.setPicture(id, null);
    await world.until(() => world.view(erin, id)?.picture === undefined, 3 * 60_000);
    expect(world.view(erin, id)?.name).toBe("Town square");
    const again = new Groups((erin.groups as unknown as { host: GroupsHost }).host, erin.store);
    await again.load();
    expect(again.views().find(v => v.id === id)?.name).toBe("Town square");
  });
});
