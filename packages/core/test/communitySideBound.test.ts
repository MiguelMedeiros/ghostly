import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { COMMUNITY_LIMITS, CommunitySession, communityCommitHash, type CommunityCommit, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.join

/*
 * The commits a member keeps off the branch it follows. Each is weighed again at every commit taken (`bestBranch`), and
 * all of them are saved with the group, so how many one signer's commits may take, and for how long, bounds what every
 * member pays for them: a member signing hundreds of admissions after the same commit made every other member's app
 * slower at every message and its saved group four times larger, for good.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession }

class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: () => {},
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Ghosts")); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const batch = this.pending.splice(0);
      if (!batch.length) { await sleep(0); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
}

const quiet: CommunitySessionHooks = { save: async () => {}, broadcast: () => {}, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };

/** `count` admissions of made-up keys signed by `m`, each after its current tip, as a copy of its app would sign them. */
async function signedAfterTip(m: Member, count: number): Promise<{ copy: CommunitySession; commit: CommunityCommit; signed: CommunityCommit[] }[]> {
  const out: { copy: CommunitySession; commit: CommunityCommit; signed: CommunityCommit[] }[] = [];
  for (let i = 0; i < count; i++) {
    const signed: CommunityCommit[] = [];
    const copy = new CommunitySession(clone(m.session.state), { ...quiet, broadcast: f => { if (f.t === "group-commit") signed.push(f.commit); } });
    await copy.admit(createIdentity().pubKeyZ32);
    out.push({ copy, commit: signed[0], signed });
  }
  return out;
}

const commitFrame = (m: Member, commit: CommunityCommit): CommunityFrame => ({ t: "group-commit", v: 2, g: m.session.id, commit: clone(commit) });
const sideBy = (m: Member, key: string) => m.session.state.side.filter(c => c.by === key);
const knows = (m: Member, h: string) => [...m.session.state.chain, ...m.session.state.side].some(c => communityCommitHash(c) === h);

describe("the commits a member keeps off its branch are bounded per signer and age out", { timeout: 120_000 }, () => {
  it("one member's flood of admissions after the same commit keeps a handful, and everyone still follows the same branch", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const dave = await net.admit(alice, "Dave");
    await net.settle();
    // Dave lets someone in in the same moment as Bob signs his: a genuine race, kept on both sides.
    const [race] = await signedAfterTip(dave, 1);
    const flood = await signedAfterTip(bob, 3 * COMMUNITY_LIMITS.sideTips + 20);
    await carol.session.handle(dave.session.myKey, commitFrame(dave, race.commit));
    for (const { commit } of flood) await carol.session.handle(bob.session.myKey, commitFrame(bob, commit));
    // Alice takes the same commits in the other order.
    for (const { commit } of [...flood].reverse()) await alice.session.handle(bob.session.myKey, commitFrame(bob, commit));
    await alice.session.handle(dave.session.myKey, commitFrame(dave, race.commit));

    for (const m of [alice, carol]) {
      expect(sideBy(m, bob.session.myKey).length).toBeLessThanOrEqual(COMMUNITY_LIMITS.sideTips);
      expect(knows(m, communityCommitHash(race.commit))).toBe(true);
    }
    // The lowest hash of them all, whatever each kept (WISP 903 § Races and forks, rule 4).
    const lowest = [race, ...flood].map(x => communityCommitHash(x.commit)).sort()[0];
    expect(carol.session.topHash).toBe(lowest);
    expect(alice.session.topHash).toBe(lowest);

    // A branch let go comes again whole once it grows (a catch-up brings it from where it parts), and wins.
    const gone = flood.find(x => !knows(carol, communityCommitHash(x.commit)))!;
    expect(gone).toBeDefined();
    await gone.copy.admit(createIdentity().pubKeyZ32);
    const next = gone.signed[1];
    await carol.session.handle(bob.session.myKey, commitFrame(bob, gone.commit));
    await carol.session.handle(bob.session.myKey, commitFrame(bob, next));
    expect(carol.session.topHash).toBe(communityCommitHash(next));
  });

  it("one member's long branches keep its newest commits, whole, and everyone still follows the same branch", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    await net.settle();
    // Branches of ten admissions each after the same commit, as many as the bound on Bob's branches holds.
    const branches = await signedAfterTip(bob, COMMUNITY_LIMITS.sideTips);
    for (const { copy } of branches) for (let i = 1; i < 10; i++) await copy.admit(createIdentity().pubKeyZ32);
    for (const { signed } of branches) for (const c of signed) await carol.session.handle(bob.session.myKey, commitFrame(bob, c));
    for (const { signed } of [...branches].reverse()) for (const c of signed) await alice.session.handle(bob.session.myKey, commitFrame(bob, c));

    for (const m of [alice, carol]) {
      const side = sideBy(m, bob.session.myKey);
      expect(side.length).toBeLessThanOrEqual(COMMUNITY_LIMITS.sideCommits);
      // Every one kept still reaches the main branch.
      for (const c of side) expect(knows(m, c.p)).toBe(true);
    }
    // Of the same length: the one whose first commit has the lowest hash.
    const best = [...branches].sort((a, b) => communityCommitHash(a.commit) < communityCommitHash(b.commit) ? -1 : 1)[0];
    expect(carol.session.topHash).toBe(communityCommitHash(best.signed[9]));
    expect(alice.session.topHash).toBe(carol.session.topHash);
  });
});
