// covers: groups.community.leave
import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import { toBase64Url } from "../src/bytes";
import { confirmationTag, epochKeys, newEpochSecret } from "../src/groupCrypto";
import {
  COMMUNITY_LIMITS, CommunitySession, communityCommitHash, communityRoster, communityUntaggedHash, leaveStatement, rosterHash, shortHash, signCommunity,
  type CommunityCommit, type CommunityState,
} from "../src/groupCommunity";
import type { Roster } from "../src/groupCommits";

const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/identity", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/identity")>();
  return { ...actual, verify: (...args: Parameters<typeof actual.verify>) => { verified.calls++; return actual.verify(...args); } };
});

const hooks = { save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };

/** A community whose members came in and left again, one after the other, past the window of rosters kept. */
function leftOverTime(members: number): { state: CommunityState; first: string } {
  const state = CommunitySession.create("Ghosts", 1);
  const admin = identityFromSeedB64(state.seedB64);
  let parent = state.chain[0], roster: Roster = [[admin.pubKeyZ32, "admin"]];
  const next = (fields: Partial<CommunityCommit> & Pick<CommunityCommit, "k">) => {
    const base = { v: 2 as const, g: state.id, e: parent.e + 1, p: communityCommitHash(parent), by: admin.pubKeyZ32, ts: 2, ...fields };
    roster = communityRoster(roster, base)!;
    const d = { ...base, m: rosterHash(roster) } as Omit<CommunityCommit, "sig" | "c">;
    parent = signCommunity({ ...d, c: confirmationTag(epochKeys(newEpochSecret(), state.id, d.e).confirm, communityUntaggedHash(d)) }, admin.seed);
    state.chain.push(parent);
  };
  let first = "";
  for (let i = 0; i < members; i++) {
    const member = createIdentity();
    first ||= member.pubKeyZ32;
    next({ k: "add", s: member.pubKeyZ32 });
    next({ k: "leave", s: member.pubKeyZ32, ls: toBase64Url(sign(leaveStatement(state.id, member.pubKeyZ32), member.seed)) });
  }
  return { state, first };
}

describe("a stored community chain", () => {
  it("replays at start, and for an epoch older than the window, without checking its leave statements again", () => {
    const { state, first } = leftOverTime(COMMUNITY_LIMITS.window);
    // A side commit off epoch 2 (after `first` left), older than the window: its parent's roster is replayed, not kept.
    const admin = identityFromSeedB64(state.seedB64), parent = state.chain[2], roster: Roster = [[admin.pubKeyZ32, "admin"]];
    const s = createIdentity().pubKeyZ32;
    const base = { v: 2 as const, g: state.id, e: 3, p: communityCommitHash(parent), k: "add" as const, by: admin.pubKeyZ32, s, m: rosterHash(communityRoster(roster, { k: "add", by: admin.pubKeyZ32, s, g: state.id })!), ts: 3 };
    const side = signCommunity({ ...base, c: confirmationTag(epochKeys(newEpochSecret(), state.id, 3).confirm, communityUntaggedHash(base)) }, admin.seed);
    state.side.push(side);
    verified.calls = 0;
    const session = new CommunitySession(state, hooks);
    expect(session.roster).toEqual(roster);
    expect(session.wasRemoved(first)).toBe(true);
    expect(session.commitByShort(3, shortHash(communityCommitHash(side)))?.commit).toEqual(side);
    // The side commit came from outside the stored main branch: its own signature is checked, and nothing else.
    expect(verified.calls).toBe(1);
  });
});
