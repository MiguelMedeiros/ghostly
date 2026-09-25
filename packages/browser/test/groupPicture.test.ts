import { describe, expect, it } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { Groups, type GroupsHost } from "../src/engine/groups";
// covers: groups.picture.set, groups.picture.late-joiner

/**
 * A group's picture (WISP 9xx § Metadata) through the real community engine on headless peers:
 * the admin sets it, members get it through the hubs, someone let in by a member while the admin is
 * away gets it at their first sync, it changes and goes for everyone, and each change leaves a line.
 * The mesh profile's engine path is in `groups.test.ts`.
 */
function jpeg(fill: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, fill, 0xff, 0xd9));
}
const RED = jpeg(1), BLUE = jpeg(2);

const pictureLines = (world: CommunityWorld, peer: Peer, id: string) => peer.messages.filter(m => m.linkId === `group:${id}` && m.event === "picture").map(m => m.text);

describe("group picture on headless community engines", { timeout: 120_000 }, () => {
  it("set by the admin, seen by everyone through the hubs and by someone let in later; changed and removed for everyone", async () => {
    const world = new CommunityWorld();
    let largest = 0;
    world.drop = (_from, _to, frame) => { if (frame.t === "group-meta") largest = Math.max(largest, JSON.stringify(frame).length); return false; };
    const alice = world.add("alice"), others = ["bob", "carol", "dave", "erin"].map(name => world.add(name));
    const id = await alice.groups.create("Plaza");
    const link = await alice.groups.enableLink(id);
    for (const p of others) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => others.every(p => world.member(p, id)), 10 * 60_000);
    await world.run(20_000);

    await expect(others[0].groups.setPicture(id, RED)).rejects.toThrow("Only the admin");
    await alice.groups.setPicture(id, RED);
    expect(world.view(alice, id)?.picture).toBe(RED);
    await world.until(() => others.every(p => world.view(p, id)?.picture === RED), 60_000);
    expect(pictureLines(world, alice, id)).toEqual(["You changed the group's picture"]);
    for (const p of others) expect(pictureLines(world, p, id)).toHaveLength(1);
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThan(60 * 1024);

    // The admin goes away; Frank joins by the link, let in by a member, and sees the picture.
    alice.online = false;
    const frank = world.add("frank");
    await frank.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(frank, id), 10 * 60_000);
    await world.until(() => world.view(frank, id)?.picture === RED, 3 * 60_000);

    // Back, the admin changes it, then removes it: everyone follows.
    alice.online = true;
    await world.run(15_000);
    await alice.groups.setPicture(id, BLUE);
    const everyone = [alice, ...others, frank];
    await world.until(() => everyone.every(p => world.view(p, id)?.picture === BLUE), 3 * 60_000);
    await alice.groups.setPicture(id, null);
    await world.until(() => everyone.every(p => world.view(p, id)?.picture === undefined), 3 * 60_000);
    expect(pictureLines(world, frank, id).at(-1)).toMatch(/removed the group's picture$/);

    // After a restart, what was kept is what is shown.
    await alice.groups.setPicture(id, RED);
    await world.until(() => world.view(frank, id)?.picture === RED, 3 * 60_000);
    const again = new Groups((frank.groups as unknown as { host: GroupsHost }).host, frank.store);
    await again.load();
    expect(again.views().find(v => v.id === id)?.picture).toBe(RED);
  });

  it("two changes within one engine tick each leave a line, for the admin and for every member", async () => {
    // The engine's clock is its last tick's (once a second): lines named by it alone were one line for
    // both changes, and the second was dropped as already there (e2e/web/group-picture.spec.ts, on a fast relay).
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Plaza");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(bob, id), 10 * 60_000);
    await world.run(20_000);

    await alice.groups.setPicture(id, RED);
    await alice.groups.setPicture(id, null);
    expect(pictureLines(world, alice, id)).toEqual(["You changed the group's picture", "You removed the group's picture"]);
    await world.until(() => pictureLines(world, bob, id).length === 2, 60_000);
    const lines = pictureLines(world, bob, id);
    expect(lines[0]).toMatch(/changed the group's picture$/);
    expect(lines[1]).toMatch(/removed the group's picture$/);
  });
});
