import { describe, expect, it, vi } from "vitest";
import { COMMUNITY_LIMITS, CommunitySession, createIdentity, type CommunityState } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.protocol.community-topology

// Every SHA-256 the engine computes, counted: a view should cost none per member.
const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/hashes/sha2.js", async original => {
  const real = await original<typeof import("@noble/hashes/sha2.js")>();
  const sha256 = Object.assign((data: Uint8Array) => { hashes.count++; return real.sha256(data); }, real.sha256);
  return { ...real, sha256 };
});

const quiet = { save: async () => {}, broadcast: () => {}, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };

/** A community at the member cap, admitted by real signed `add` commits, whose members have names and wrote in this epoch. */
async function bigCommunity(name: string): Promise<CommunityState> {
  const state = CommunitySession.create(name);
  const session = new CommunitySession(state, quiet);
  for (let i = 1; i < COMMUNITY_LIMITS.members; i++) {
    const key = createIdentity().pubKeyZ32;
    await session.admit(key);
    state.nicks[key] = `member ${i}`;
  }
  await session.flush();
  const epochKey = `${session.epoch}:${session.topHash.slice(0, 16)}`;
  for (const key of session.others) state.seen[key] = { [epochKey]: { high: 5, window: [1, 2] } };
  return structuredClone(state);
}

/**
 * Each engine state builds every group's view. A community's view read its top commit's hash again for each member
 * (once for the roster, once more for what that member's lines are missing): 10 communities of 256 members cost about
 * 5,000 SHA-256 per state, tens of milliseconds of main thread each time anything changed.
 */
describe("a community's view", () => {
  it("hashes no commit per member, at the member cap", async () => {
    const groups = new Map<string, StoredGroup>();
    for (const name of ["One", "Two"]) {
      const community = await bigCommunity(name);
      groups.set(community.id, { id: community.id, createdAt: community.createdAt, community });
    }
    const store: GroupStore = { getGroups: async () => [...groups.values()], putGroup: async g => { groups.set(g.id, structuredClone(g)); }, deleteGroup: async id => { groups.delete(id); }, getMessages: async () => [] };
    const host: GroupsHost = {
      sendOnLink: () => {}, linkReady: () => true, contactName: () => "", edges: () => new Map(), openEdge: async () => "edge", closeEdge: async () => {},
      edgeNick: () => undefined, openEntry: async () => "entry", entries: () => new Map(), publish: async () => {}, resolve: async () => null, storeMessage: async () => {}, emit: () => {},
    };
    const app = new Groups(host, store);
    await app.load(true);

    const first = app.views();
    expect(first).toHaveLength(2);
    expect(first.every(v => v.members.length === COMMUNITY_LIMITS.members)).toBe(true);
    expect(first.flatMap(v => v.members).filter(m => !m.me).every(m => m.missing === 3 && !!m.nick)).toBe(true);

    hashes.count = 0;
    const again = app.views();
    expect(again).toEqual(first);
    // At most one per group (its top commit), never one per member.
    expect(hashes.count).toBeLessThanOrEqual(groups.size);
  }, 120_000);
});
