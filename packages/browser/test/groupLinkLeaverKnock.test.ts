import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld } from "./communityWorld";
// covers: groups.protocol.entry

/**
 * agents#1667: a private group whose members come and go by its link. The knock a member left in the link's record
 * when it joined stays there for up to `KNOCK_TTL_MS` after it leaves; the admin took it for a new joiner's and
 * opened an entry session nobody answers, holding one of the link's 4 places for 3 minutes. The next person to open
 * the link waited 1-3 minutes instead of ~3 s (hub lab: 48 entry sessions for 24 joins).
 */
describe("a private group's link, its members gone again", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("opens no entry session for the knock of a member who left, and the next joiner is in at once", async () => {
    const world = new CommunityWorld();
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    const admin = world.add("admin");
    const id = await admin.groups.create("Door", "mesh");
    const link = await admin.groups.enableLink(id);
    const hosted: string[] = [];
    const open = admin.host.openEntry.bind(admin.host);
    admin.host.openEntry = async (l, role, seedB64, other) => { if (role === "host") hosted.push(other); return open(l, role, seedB64, other); };
    const first = ["m0", "m1", "m2", "m3"].map(n => world.add(n));
    for (const p of first) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 3 * 60_000); }
    const keys = first.map(p => world.view(p, id)!.myKey!);
    for (const p of first) await p.groups.leave(id);
    await world.until(() => world.view(admin, id)!.members.length === 1, 60_000);
    hosted.length = 0;
    // The next person opens the link a few seconds after they left, their knocks still in the record.
    await world.run(5_000);
    const next = world.add("m4");
    await next.groups.joinByLink(link);
    const took = await world.until(() => world.member(next, id), 5 * 60_000);
    const forLeavers = hosted.filter(k => keys.includes(k)).length;
    console.log(`LEAVERS' KNOCKS: ${forLeavers} entry sessions opened for them, ${hosted.length} in all; the next joiner in after ${took} ms`);
    expect(forLeavers, "no entry session for a member who left").toBe(0);
    expect(took).toBeLessThan(30_000);
  });
});
