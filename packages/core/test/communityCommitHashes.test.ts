import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.protocol.community-topology

// Every SHA-256 the session takes: a commit's hash is one.
const hashed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/groupCrypto", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/groupCrypto")>();
  return { ...actual, sha256Hex: (...args: Parameters<typeof actual.sha256Hex>) => { hashed.calls++; return actual.sha256Hex(...args); } };
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function community() {
  const sessions: CommunitySession[] = [];
  const pending: Promise<unknown>[] = [];
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const hooks = (self: () => CommunitySession): CommunitySessionHooks => ({
    save: async () => {},
    broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
    direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
    addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
    message: () => {},
    changed: () => {},
  });
  const add = (state: CommunityState): CommunitySession => {
    let s: CommunitySession = null as unknown as CommunitySession;
    s = new CommunitySession(clone(state), hooks(() => s));
    sessions.push(s);
    return s;
  };
  return { add, settle };
}

/*
 * A commit never changes once made, and a session holds the same few dozen (the window of 64 and its side branches):
 * their hashes are taken once, not again at every sync, sync answer and commit. At 64 and 128 members the load test
 * spent about a tenth of its CPU hashing the same commits again (2026-11-13).
 */
describe("a community session's commit hashes", { timeout: 60_000 }, () => {
  it("are not taken again for each sync frame, sync answer or commit", async () => {
    const { add, settle } = community();
    const admin = add(CommunitySession.create("Ghosts"));
    const seed = createIdentity().seedB64;
    const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    const bob = add(joined.state);
    await settle();
    // A chain longer than the window.
    for (let i = 0; i < 70; i++) { await admin.admit(createIdentity().pubKeyZ32); await settle(); }
    expect(bob.epoch).toBe(admin.epoch);
    await bob.handle(admin.myKey, clone(admin.syncFrame(bob.myKey)));
    await admin.handle(bob.myKey, clone(bob.syncFrame(admin.myKey)));
    await settle();

    let before = hashed.calls;
    for (let i = 0; i < 10; i++) admin.syncFrame(bob.myKey);
    const perSync = (hashed.calls - before) / 10;

    before = hashed.calls;
    for (let i = 0; i < 10; i++) { await admin.handle(bob.myKey, clone(bob.syncFrame(admin.myKey))); await settle(); }
    const perAnswer = (hashed.calls - before) / 10;

    // A commit hashes itself, its roster and the untagged commit, and what it was made from: not the whole window again.
    before = hashed.calls;
    await admin.admit(createIdentity().pubKeyZ32); await settle();
    const perCommit = hashed.calls - before;

    console.log(`commit hashes: ${perSync} per sync frame, ${perAnswer} per sync and its answer, ${perCommit} per commit (both sides)`);
    expect(perSync).toBeLessThanOrEqual(2);
    expect(perAnswer).toBeLessThanOrEqual(4);
    expect(perCommit).toBeLessThanOrEqual(20);
  });
});
