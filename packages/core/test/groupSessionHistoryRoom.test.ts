import { describe, expect, it } from "vitest";
import { MAX_GROUP_CHAIN } from "../src/groupCommits";
import { createIdentity } from "../src/identity";
import { GroupSession } from "../src/groupSession";
// covers: groups.remove-member, groups.leave, groups.rotate

/*
 * A private group's membership history holds MAX_GROUP_CHAIN commits and is never compacted. As in a community
 * (groupCommunityHistoryRoom.test.ts), the admin keeps room in it for everyone to get out: a leave or a remove is one
 * commit, and a leaving admin hands the role over first (two), so an add or a rotate stops while that room would no
 * longer be there. Members who join by the link and leave make two commits each: churn alone filled it.
 */
const hooks = { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} };
const FULL = /membership history limit/;

describe("a private group near the end of its membership history", () => {
  it("takes no one new and no new key while everyone in it could not leave any more, and lets them all out", async () => {
    const admin = new GroupSession(GroupSession.create("Ghosts"), hooks);
    const members: string[] = [];
    for (let i = 0; i < 7; i++) { const key = createIdentity().pubKeyZ32; members.push(key); await admin.admit(key); }
    // People who came by the link and left, until an add would no longer fit.
    let refused: unknown;
    while (admin.state.chain.length < MAX_GROUP_CHAIN && !refused) {
      const passing = createIdentity().pubKeyZ32;
      try { await admin.admit(passing); } catch (error) { refused = error; break; }
      await admin.remove(passing);
    }
    // A new key adds no member: it fits while the room for the others' way out is there, and no further.
    for (let i = 0; i < 4 && admin.state.chain.length < MAX_GROUP_CHAIN; i++) await admin.rotate().catch(() => {});
    const full = admin.state.chain.length;
    await expect(admin.rotate()).rejects.toThrow(FULL);

    // Everyone still gets out: the admin removes all but one, hands the role to that one, who removes the old admin.
    const heir = members.pop()!;
    for (const key of members) await admin.remove(key);
    await admin.transferAdmin(heir);
    expect(admin.roster.map(([key]) => key).sort()).toEqual([admin.myKey, heir].sort());
    expect(admin.state.chain.length).toBeLessThan(MAX_GROUP_CHAIN);

    // What stopped the passers-by was the room kept for the 7 others.
    expect(String(refused)).toMatch(FULL);
    expect(MAX_GROUP_CHAIN - full).toBeGreaterThanOrEqual(2 * 7);
  }, 60_000);
});
