import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import { toBase64Url } from "../src/bytes";
import { COMMUNITY_LIMITS, CommunitySession, leaveStatement, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave, groups.community.remove

/*
 * A community's membership history holds COMMUNITY_LIMITS.chain commits and is never compacted. A committer keeps room
 * in it for everyone to get out: a leave or a remove is one commit, and a leaving admin hands the role over first (two),
 * so what makes the history longer without making the group smaller (add, link, rotate) stops while that room would no
 * longer be there. The limit is lowered here (the session reads it at run time); the real one takes minutes to reach.
 */
const limits = COMMUNITY_LIMITS as unknown as { chain: number };
const saved = limits.chain;
afterEach(() => { limits.chain = saved; });

const hooks = { save: async (_state: CommunityState) => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };
const FULL = /membership history limit/;

function leaveOf(group: string, seedB64: string) {
  const id = identityFromSeedB64(seedB64);
  return { t: "group-leave", v: 2, g: group, s: id.pubKeyZ32, ls: toBase64Url(sign(leaveStatement(group, id.pubKeyZ32), id.seed)) };
}

describe("a community near the end of its membership history", () => {
  it("takes no one new and no new link or key while everyone in it could not leave any more, and lets them all out", async () => {
    limits.chain = 22;
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    const members: string[] = [];
    for (let i = 0; i < 7; i++) { const id = createIdentity(); members.push(id.seedB64); await admin.admit(id.pubKeyZ32); }
    // 8 commits, 8 members: 14 left, what the 7 others need at most (each may be the admin when it leaves).
    expect(admin.state.chain.length).toBe(8);
    const link = admin.entryKey;
    await expect(admin.admit(createIdentity().pubKeyZ32)).rejects.toThrow(FULL);
    await expect(admin.rotate()).rejects.toThrow(FULL);
    await expect(admin.replaceLink()).rejects.toThrow(FULL);
    await expect(admin.replaceLink(true)).rejects.toThrow(FULL);
    expect(admin.state.chain.length).toBe(8);
    expect(admin.entryKey).toBe(link);
    expect(limits.chain - admin.state.chain.length).toBeGreaterThanOrEqual(2 * (admin.roster.length - 1));

    // Someone removed gives one commit of room back, and a newcomer in their place would need three.
    await admin.remove(identityFromSeedB64(members.shift()!).pubKeyZ32);
    await expect(admin.admit(createIdentity().pubKeyZ32)).rejects.toThrow(FULL);

    // The admin hands the role over, and as a member commits the leave of everyone but the new admin.
    const heir = identityFromSeedB64(members.shift()!).pubKeyZ32;
    await admin.transferAdmin(heir);
    for (const seedB64 of members) {
      await admin.handle(identityFromSeedB64(seedB64).pubKeyZ32, leaveOf(admin.id, seedB64));
      expect(await admin.commitPendingLeaves()).toBe(1);
    }
    expect(admin.roster.map(([key]) => key).sort()).toEqual([admin.myKey, heir].sort());
    expect(admin.state.chain.length).toBeLessThanOrEqual(limits.chain);
  });

  it("still takes the leaves, removes and handovers of a history an older app filled past that room", async () => {
    limits.chain = 64;
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    const members: string[] = [];
    for (let i = 0; i < 6; i++) { const id = createIdentity(); members.push(id.seedB64); await admin.admit(id.pubKeyZ32); }
    limits.chain = 10; // 7 commits, 7 members: three left, fewer than the six others would need
    await expect(admin.admit(createIdentity().pubKeyZ32)).rejects.toThrow(FULL);
    await admin.handle(identityFromSeedB64(members[0]).pubKeyZ32, leaveOf(admin.id, members[0]));
    expect(await admin.commitPendingLeaves()).toBe(1);
    await admin.remove(identityFromSeedB64(members[1]).pubKeyZ32);
    await admin.transferAdmin(identityFromSeedB64(members[2]).pubKeyZ32);
    expect(admin.state.chain.length).toBe(10);
    expect(admin.roster.length).toBe(5);
  });
});
