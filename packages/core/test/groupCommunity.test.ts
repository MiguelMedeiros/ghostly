import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import { toBase64Url } from "../src/bytes";
import { confirmationTag, epochKeys, newEpochSecret } from "../src/groupCrypto";
import {
// covers: groups.protocol.community-commits, groups.community.join, groups.community.remove, groups.community.leave, groups.community.late-joiner
  COMMUNITY_LIMITS, CommunitySession, communityCommitHash, communityGroupId, communityRoster, communityUntaggedHash, leaveStatement, rosterHash, shortHash,
  signCommunity, verifyCommunityChain, verifyCommunityCommit,
  type CommunityCommit, type CommunityFrame, type CommunityIncomingMessage, type CommunityState,
} from "../src/groupCommunity";
import type { Roster } from "../src/groupCommits";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member { name: string; session: CommunitySession; saved: CommunityState; messages: CommunityIncomingMessage[]; online: boolean; seedB64: string }

/**
 * Members on one network where every frame someone broadcasts reaches every online member (what
 * the hubs do), `direct` and `addressed` reach one member, and nothing reaches whoever is offline.
 * Partitions: members only hear members of their own partition.
 */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];
  partition: ((a: Member, b: Member) => boolean) | null = null;
  delivered = 0;

  private hooks(name: string) {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me || (this.partition && !this.partition(me, to))) return;
      this.delivered++;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async (state: CommunityState) => { this.members.get(name)!.saved = state; },
      broadcast: (frame: CommunityFrame) => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      message: (m: CommunityIncomingMessage) => { this.members.get(name)!.messages.push(m); },
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  create(name: string): Member {
    const state = CommunitySession.create("Ghosts");
    const member: Member = { name, session: null as unknown as CommunitySession, saved: state, messages: [], online: true, seedB64: state.seedB64 };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  /** `by` admits a newcomer over the link (the entry session is not simulated: its frames are handed over). */
  async admit(by: Member, name: string, link = { g: by.session.id, host: by.session.entryKey }): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const key = identityFromSeedB64(seedB64).pubKeyZ32;
    const frames = await by.session.admit(key);
    await this.settle();
    const welcome = frames[frames.length - 1], pieces = frames.slice(0, -1);
    const joined = CommunitySession.join(link, clone(pieces), clone(welcome), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    const member: Member = { name, session: null as unknown as CommunitySession, saved: joined.state, messages: [], online: true, seedB64 };
    this.members.set(name, member);
    member.session = new CommunitySession(joined.state, this.hooks(name));
    return member;
  }
  /** Two members meet (an edge opens): both say where they are. */
  async meet(a: Member, b: Member): Promise<void> {
    if (!a.online || !b.online) return;
    this.pending.push(b.session.handle(a.session.myKey, clone(a.session.syncFrame())), a.session.handle(b.session.myKey, clone(b.session.syncFrame())));
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
  texts(m: Member): string[] { return m.messages.map(x => x.text); }
  /** Restarts a member from what it saved. */
  async restart(m: Member): Promise<void> { await m.session.flush(); m.session = new CommunitySession(clone(m.saved), this.hooks(m.name)); }
}

/**
 * A commit signed by `signer` after `parent` (whose roster is `parentRoster`), as a member crafting
 * a branch by hand would: anything the rules let a member of that roster sign.
 */
function forge(signer: Member, parent: CommunityCommit, parentRoster: Roster, fields: Partial<CommunityCommit> & Pick<CommunityCommit, "k">, ts = 5): { commit: CommunityCommit; roster: Roster } {
  const base = { v: 2 as const, g: parent.g, e: parent.e + 1, p: communityCommitHash(parent), by: signer.session.myKey, ts, ...fields };
  const roster = communityRoster(parentRoster, base);
  if (!roster) throw new Error(`not allowed: ${fields.k}`);
  const d = { ...base, m: rosterHash(roster) } as Omit<CommunityCommit, "sig" | "c">;
  return { commit: signCommunity({ ...d, c: confirmationTag(epochKeys(newEpochSecret(), parent.g, d.e).confirm, communityUntaggedHash(d)) }, identityFromSeedB64(signer.seedB64).seed), roster };
}
/** `count` admissions of throwaway keys signed by `signer`, one after the other from `parent`. */
function addBranch(signer: Member, parent: CommunityCommit, parentRoster: Roster, count: number): CommunityCommit[] {
  const out: CommunityCommit[] = [];
  for (let i = 0; i < count; i++) {
    const next = forge(signer, parent, parentRoster, { k: "add", s: createIdentity().pubKeyZ32 });
    out.push(next.commit); parent = next.commit; parentRoster = next.roster;
  }
  return out;
}
const commitFrame = (commit: CommunityCommit) => ({ t: "group-commit", v: 2, g: commit.g, commit: clone(commit) });

async function say(net: Net, m: Member, text: string): Promise<void> {
  const result = await m.session.sendText(text, m.name);
  if ("error" in result) throw new Error(result.error);
  await net.settle();
}

describe("community commits", () => {
  const admin = createIdentity(), bob = createIdentity(), carol = createIdentity();
  const n = toBase64Url(new Uint8Array(16).fill(7));
  const g = communityGroupId(admin.pubKeyZ32, n);
  const entry = createIdentity().pubKeyZ32;
  const make = (parent: CommunityCommit | null, parentRoster: CommunityCommit extends never ? never : Parameters<typeof communityRoster>[0], fields: Partial<CommunityCommit> & Pick<CommunityCommit, "k" | "by">, seed: Uint8Array) => {
    const base = { v: 2 as const, g, e: parent ? parent.e + 1 : 0, p: parent ? communityCommitHash(parent) : "", ts: 1, ...fields };
    const roster = communityRoster(parentRoster, base) ?? [];
    const d = { ...base, m: rosterHash(roster) } as Omit<CommunityCommit, "sig" | "c">;
    return { commit: signCommunity({ ...d, c: confirmationTag(epochKeys(newEpochSecret(), g, d.e).confirm, communityUntaggedHash(d)) }, seed), roster };
  };
  const genesis = make(null, null, { k: "create", by: admin.pubKeyZ32, x: entry, n }, admin.seed);
  const addBob = make(genesis.commit, genesis.roster, { k: "add", by: admin.pubKeyZ32, s: bob.pubKeyZ32 }, admin.seed);

  it("binds the group id to its genesis: another genesis cannot claim it", () => {
    expect(verifyCommunityChain(clone([genesis.commit, addBob.commit]))).toHaveProperty("chain");
    const other = createIdentity();
    const impostor = make(null, null, { k: "create", by: other.pubKeyZ32, x: entry, n }, other.seed);
    expect(verifyCommunityCommit(clone(impostor.commit), null, null, g)).toHaveProperty("error", "The group id is not this genesis's");
  });

  it("any member admits; only the admin removes, re-roles, rotates or re-links; a leave needs the leaver's signature", () => {
    // Bob, a member, admits Carol.
    const addCarol = make(addBob.commit, addBob.roster, { k: "add", by: bob.pubKeyZ32, s: carol.pubKeyZ32 }, bob.seed);
    expect(verifyCommunityCommit(clone(addCarol.commit), addBob.commit, addBob.roster)).toHaveProperty("commit");
    for (const k of ["remove", "role"] as const) {
      const c = make(addCarol.commit, addCarol.roster, { k, by: bob.pubKeyZ32, s: carol.pubKeyZ32 }, bob.seed);
      expect(verifyCommunityCommit(clone(c.commit), addCarol.commit, addCarol.roster)).toHaveProperty("error", "Unauthorized or inconsistent membership change");
    }
    const rotate = make(addCarol.commit, addCarol.roster, { k: "rotate", by: bob.pubKeyZ32 }, bob.seed);
    expect(verifyCommunityCommit(clone(rotate.commit), addCarol.commit, addCarol.roster)).toHaveProperty("error");
    const relink = make(addCarol.commit, addCarol.roster, { k: "link", by: bob.pubKeyZ32, x: "" }, bob.seed);
    expect(verifyCommunityCommit(clone(relink.commit), addCarol.commit, addCarol.roster)).toHaveProperty("error");
    // A leave committed by Bob for Carol needs Carol's signature, and cannot take the admin out.
    const ls = toBase64Url(sign(leaveStatement(g, carol.pubKeyZ32), carol.seed));
    const leave = make(addCarol.commit, addCarol.roster, { k: "leave", by: bob.pubKeyZ32, s: carol.pubKeyZ32, ls }, bob.seed);
    expect(verifyCommunityCommit(clone(leave.commit), addCarol.commit, addCarol.roster)).toHaveProperty("commit");
    const forged = make(addCarol.commit, addCarol.roster, { k: "leave", by: bob.pubKeyZ32, s: carol.pubKeyZ32, ls: toBase64Url(sign(leaveStatement(g, carol.pubKeyZ32), bob.seed)) }, bob.seed);
    expect(verifyCommunityCommit(clone(forged.commit), addCarol.commit, addCarol.roster)).toHaveProperty("error");
    const adminOut = make(addCarol.commit, addCarol.roster, { k: "leave", by: bob.pubKeyZ32, s: admin.pubKeyZ32, ls: toBase64Url(sign(leaveStatement(g, admin.pubKeyZ32), admin.seed)) }, bob.seed);
    expect(verifyCommunityCommit(clone(adminOut.commit), addCarol.commit, addCarol.roster)).toHaveProperty("error");
  });

  it("refuses a roster hash that does not match, a member twice, and a non-member signer", () => {
    const wrong = { ...make(addBob.commit, addBob.roster, { k: "add", by: bob.pubKeyZ32, s: carol.pubKeyZ32 }, bob.seed).commit };
    const badHash = signCommunity({ ...wrong, m: rosterHash(addBob.roster) }, bob.seed);
    expect(verifyCommunityCommit(clone(badHash), addBob.commit, addBob.roster)).toHaveProperty("error", "The roster hash does not match the change");
    const twice = make(addBob.commit, addBob.roster, { k: "add", by: admin.pubKeyZ32, s: bob.pubKeyZ32 }, admin.seed);
    expect(verifyCommunityCommit(clone(twice.commit), addBob.commit, addBob.roster)).toHaveProperty("error");
    const stranger = make(addBob.commit, addBob.roster, { k: "add", by: carol.pubKeyZ32, s: createIdentity().pubKeyZ32 }, carol.seed);
    expect(verifyCommunityCommit(clone(stranger.commit), addBob.commit, addBob.roster)).toHaveProperty("error");
  });
});

describe("community sessions", { timeout: 60_000 }, () => {
  it("a member admits with the admin away; the admin, back, is caught up by a member who is not the author", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    alice.online = false;
    // Bob lets Carol in; neither needs Alice.
    const carol = await net.admit(bob, "carol");
    await net.meet(bob, carol);
    await say(net, carol, "carol here");
    await say(net, bob, "bob here");
    expect(net.texts(bob)).toEqual(["carol here", "bob here"]);
    expect(net.texts(carol)).toEqual(["carol here", "bob here"]);
    expect(carol.session.roster).toHaveLength(3);
    // Carol goes away before Alice returns: Bob hands Alice the commit and Carol's message.
    carol.online = false;
    alice.online = true;
    await net.meet(alice, bob);
    expect(alice.session.roster.map(([k]) => k)).toContain(carol.session.myKey);
    expect(net.texts(alice)).toEqual(expect.arrayContaining(["carol here", "bob here"]));
    // Names travel encrypted with the messages.
    expect(alice.session.state.nicks[carol.session.myKey]).toBe("carol");
  });

  it("adding derives the next secret: members compute it, the newcomer cannot go back", async () => {
    const net = new Net();
    const alice = net.create("alice");
    await say(net, alice, "before bob");
    const bob = await net.admit(alice, "bob");
    const hashes = alice.session.state.chain.map(c => communityCommitHash(c));
    expect(alice.session.state.secrets[hashes[1]]).toBe(bob.session.state.secrets[hashes[1]]);
    expect(bob.session.state.secrets[hashes[0]]).toBeUndefined();
    // Alice's store has "before bob", but a sync does not hand it to Bob: he was not a member then.
    await net.meet(alice, bob);
    expect(net.texts(bob)).toEqual([]);
    const carol = await net.admit(bob, "carol");
    // Alice derives Carol's epoch herself: nothing was sealed to her for it.
    expect(alice.session.state.secrets[carol.session.topHash]).toBe(carol.session.state.secrets[carol.session.topHash]);
  });

  it("a removal gives everyone else a fresh secret; the removed member reads nothing after and is told", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob"), carol = await net.admit(alice, "carol");
    await net.meet(alice, bob); await net.meet(alice, carol);
    await alice.session.remove(carol.session.myKey);
    await net.settle();
    expect(carol.session.status).toBe("removed");
    expect(Object.keys(carol.session.state.secrets)).toEqual([]);
    expect(bob.session.canSend).toBe(true);
    await say(net, bob, "after carol");
    expect(net.texts(alice)).toContain("after carol");
    expect(net.texts(carol)).not.toContain("after carol");
    // A member cannot remove anyone.
    await expect(bob.session.remove(alice.session.myKey)).rejects.toThrow(/Only the admin/);
  });

  it("a leave is committed by another member on the leaver's request, with a fresh secret", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob"), carol = await net.admit(alice, "carol");
    alice.online = false;
    await net.meet(bob, carol);
    await carol.session.leave();
    await net.settle();
    expect(carol.session.status).toBe("left");
    expect(bob.session.state.pendingLeaves.map(r => r.s)).toEqual([carol.session.myKey]);
    expect(await bob.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    expect(bob.session.roster).toHaveLength(2);
    expect(bob.session.top.k).toBe("leave");
    // Alice, back, gets the leave and its fresh secret from Bob.
    alice.online = true;
    await net.meet(alice, bob);
    expect(alice.session.roster).toHaveLength(2);
    expect(alice.session.canSend).toBe(true);
    await say(net, alice, "just us");
    expect(net.texts(bob)).toContain("just us");
  });

  it("two members admitting at once is a race everyone settles the same way, whatever the order", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob"), carol = await net.admit(alice, "carol");
    await net.meet(bob, carol);
    // Bob and Carol cannot hear each other; each lets someone in, and each newcomer talks.
    const left = new Set([bob]);
    net.partition = (a, b) => left.has(a) === left.has(b);
    alice.online = false;
    const dave = await net.admit(bob, "dave"); left.add(dave);
    const erin = await net.admit(carol, "erin");
    await say(net, dave, "dave in the race");
    await say(net, erin, "erin in the race");
    const daveAt = dave.session.topHash, erinAt = erin.session.topHash;
    expect(daveAt).not.toBe(erinAt);
    // They meet: the branch whose first commit has the lower hash wins, on both sides.
    net.partition = null;
    await net.meet(bob, carol);
    await net.meet(bob, dave); await net.meet(carol, erin); await net.meet(bob, erin); await net.meet(carol, dave);
    const winner = daveAt < erinAt ? daveAt : erinAt;
    for (const m of [bob, carol, dave, erin]) expect(m.session.topHash).toBe(winner);
    const [won, lost] = daveAt < erinAt ? [dave, erin] : [erin, dave];
    expect(won.session.status).toBe("active");
    expect(lost.session.status).toBe("lost");
    expect(bob.session.roster.map(([k]) => k)).not.toContain(lost.session.myKey);
    // What the losing newcomer said is still readable by the members who could derive its epoch.
    for (const m of [bob, carol]) expect(net.texts(m)).toEqual(expect.arrayContaining(["dave in the race", "erin in the race"]));
    // Alice, the admin, back: follows the same branch.
    alice.online = true;
    await net.meet(alice, bob);
    expect(alice.session.topHash).toBe(winner);
    // The loser is let in again, on top of the winner, and is a member again.
    const again = await bob.session.admit(lost.session.myKey);
    void again;
    await net.settle();
    expect(bob.session.roster.map(([k]) => k)).toContain(lost.session.myKey);
  });

  it("two commits by the admin after the same commit fork the group", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    await net.meet(alice, bob);
    const parent = alice.session.top, parentRoster = alice.session.roster;
    // The admin signs a second, different commit after the same parent (as a second device would).
    const seed = identityFromSeedB64(alice.seedB64).seed;
    const base = { v: 2 as const, g: parent.g, e: parent.e + 1, p: communityCommitHash(parent), ts: 2, by: alice.session.myKey };
    const r1 = communityRoster(parentRoster, { ...base, k: "rotate" })!;
    const d1 = { ...base, k: "rotate" as const, m: rosterHash(r1) };
    const c1 = signCommunity({ ...d1, c: confirmationTag(epochKeys(newEpochSecret(), parent.g, d1.e).confirm, communityUntaggedHash(d1)) }, seed);
    await alice.session.rotate();
    await net.settle();
    await bob.session.handle(alice.session.myKey, { t: "group-commit", v: 2, g: parent.g, commit: clone(c1) });
    expect(bob.session.status).toBe("forked");
    expect(bob.session.state.statusReason).toMatch(/admin signed two different changes/);
  });

  it("a shorter branch parting long ago is not followed; a longer one is, however far back it parts", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    await net.meet(alice, bob);
    // Bob is cut off; Alice rotates many times meanwhile, and Bob lets someone in on his own.
    bob.online = false;
    for (let i = 0; i <= COMMUNITY_LIMITS.window + 4; i++) await alice.session.rotate();
    await net.settle();
    bob.online = true;
    alice.online = false;
    const carol = await net.admit(bob, "carol");
    const bobBranch = bob.session.topHash;
    // Alice, on the longer branch, does not follow Bob's shorter one…
    alice.online = true;
    await alice.session.handle(bob.session.myKey, { t: "group-commit", v: 2, g: alice.session.id, commit: clone(bob.session.top) });
    await net.settle();
    expect(alice.session.epoch).toBe(COMMUNITY_LIMITS.window + 6);
    // …and Bob, meeting her, follows hers however far back they part: his admission of Carol lost.
    await net.meet(alice, bob);
    expect(bob.session.topHash).toBe(alice.session.topHash);
    expect(bob.session.topHash).not.toBe(bobBranch);
    expect(bob.session.roster.map(([k]) => k)).not.toContain(carol.session.myKey);
    await net.meet(bob, carol);
    expect(carol.session.status).toBe("lost");
    expect(bob.session.canSend).toBe(true);
  });

  it("a replaced link admits nobody, and its new seed reaches every member", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    await net.meet(alice, bob);
    const old = { g: alice.session.id, host: alice.session.entryKey };
    const fresh = await alice.session.replaceLink();
    await net.settle();
    expect(bob.session.entryKey).toBe(fresh);
    expect(bob.session.state.entry.seedB64).toBe(alice.session.state.entry.seedB64);
    // A welcome for someone who came with the old link does not hold.
    await expect(net.admit(bob, "carol", old)).rejects.toThrow(/replaced or turned off/);
    // Bob, holding the new seed, can let people in with the new link.
    const dave = await net.admit(bob, "dave");
    expect(dave.session.roster).toHaveLength(4);
  });

  it("messages go to everyone, and a restart keeps the branch, the secrets and the store", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const members = [alice];
    for (let i = 0; i < 6; i++) members.push(await net.admit(members[i % members.length], `m${i}`));
    for (const m of members) await say(net, m, `hi from ${m.name}`);
    for (const m of members) expect(new Set(net.texts(m)).size).toBe(members.length);
    await net.restart(members[3]);
    expect(members[3].session.topHash).toBe(alice.session.topHash);
    expect(members[3].session.state.store.length).toBeGreaterThan(0);
    await say(net, members[3], "after restart");
    expect(net.texts(alice)).toContain("after restart");
    expect(shortHash(alice.session.topHash)).toHaveLength(16);
  });
});

describe("community admin changes are final", { timeout: 60_000 }, () => {
  /** Alice (admin), Bob and Carol (honest), Mallory; everyone has met. */
  async function group() {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob"), carol = await net.admit(alice, "carol"), mallory = await net.admit(bob, "mallory");
    for (const [a, b] of [[alice, bob], [alice, carol], [alice, mallory], [bob, carol]] as const) await net.meet(a, b);
    return { net, alice, bob, carol, mallory };
  }

  const changes = {
    remove: (alice: Member, mallory: Member) => alice.session.remove(mallory.session.myKey),
    link: (alice: Member) => alice.session.replaceLink(true),
    rotate: (alice: Member) => alice.session.rotate(),
    role: (alice: Member, _mallory: Member, bob: Member) => alice.session.transferAdmin(bob.session.myKey),
  } as const;

  for (const [kind, change] of Object.entries(changes)) {
    it(`a longer branch of admissions from before a ${kind} does not undo it`, async () => {
      const { net, alice, bob, carol, mallory } = await group();
      const before = alice.session.top, beforeRoster = alice.session.roster;
      await change(alice, mallory, bob);
      await net.settle();
      const adminTip = alice.session.topHash, adminRoster = alice.session.roster, adminEntry = alice.session.entryKey;
      expect(alice.session.top.k).toBe(kind);
      // Mallory, from the commit before the change, signs more admissions than the admin made commits since.
      const branch = addBranch(mallory, before, beforeRoster, 4);
      for (const commit of branch) for (const m of [bob, carol]) await m.session.handle(mallory.session.myKey, commitFrame(commit));
      await net.settle();
      for (const m of [alice, bob, carol]) {
        expect(m.session.topHash).toBe(adminTip);
        expect(m.session.roster).toEqual(adminRoster);
        expect(m.session.entryKey).toBe(adminEntry);
        expect(m.session.status).toBe("active");
      }
      if (kind === "remove") {
        expect(bob.session.roster.map(([k]) => k)).not.toContain(mallory.session.myKey);
        await say(net, bob, "after mallory");
        expect(net.texts(carol)).toContain("after mallory");
        expect(net.texts(mallory)).not.toContain("after mallory");
      }
      if (kind === "role") expect(carol.session.admin).toBe(bob.session.myKey);
    });
  }

  it("a removed member's branch is not kept or passed on; one from a member still in is kept, never followed", async () => {
    const { net, alice, bob, carol, mallory } = await group();
    const before = alice.session.top, beforeRoster = alice.session.roster;
    await alice.session.remove(mallory.session.myKey);
    await net.settle();
    const adminTip = bob.session.topHash;
    // Mallory's own branch, even relayed by a hub: nothing to relay, nothing kept.
    const theirs = addBranch(mallory, before, beforeRoster, 3);
    expect(await bob.session.handle(carol.session.myKey, commitFrame(theirs[0]))).toBe(false);
    expect(bob.session.state.side).toHaveLength(0);
    // Carol, still a member, doing the same: kept (as any losing branch is) and relayed, not followed.
    const hers = addBranch(carol, before, beforeRoster, 3);
    for (const commit of hers) expect(await bob.session.handle(carol.session.myKey, commitFrame(commit))).toBe(true);
    expect(bob.session.topHash).toBe(adminTip);
    expect(bob.session.state.side).toHaveLength(3);
  });

  it("a member away through the change who hears the longer branch first ends on the admin's", async () => {
    const { net, alice, bob, carol, mallory } = await group();
    const before = alice.session.top, beforeRoster = alice.session.roster;
    carol.online = false;
    await alice.session.remove(mallory.session.myKey);
    await net.settle();
    // Carol, back, hears Mallory's branch first: nothing on her side says it drops anything, so she follows it…
    carol.online = true;
    const branch = addBranch(mallory, before, beforeRoster, 4);
    for (const commit of branch) await carol.session.handle(mallory.session.myKey, commitFrame(commit));
    expect(carol.session.topHash).toBe(communityCommitHash(branch[3]));
    // …until she meets a member on the admin's: then she follows it, and Mallory is out.
    await net.meet(carol, bob);
    expect(carol.session.topHash).toBe(alice.session.topHash);
    expect(carol.session.roster.map(([k]) => k)).not.toContain(mallory.session.myKey);
    expect(carol.session.canSend).toBe(true);
    await say(net, carol, "back");
    expect(net.texts(alice)).toContain("back");
  });

  it("an admin change beats an admission of the same length, whatever the hashes", async () => {
    const { net, alice, bob, carol } = await group();
    const before = alice.session.top, beforeRoster = alice.session.roster;
    // Bob and the admin commit after the same commit, each unaware of the other.
    const bobs = forge(bob, before, beforeRoster, { k: "add", s: createIdentity().pubKeyZ32 }).commit;
    alice.online = false;
    await carol.session.handle(bob.session.myKey, commitFrame(bobs));
    await bob.session.handle(carol.session.myKey, commitFrame(bobs));
    expect(carol.session.topHash).toBe(communityCommitHash(bobs));
    alice.online = true;
    await alice.session.rotate();
    await net.settle();
    for (const m of [alice, bob, carol]) expect(m.session.top.k).toBe("rotate");
    expect(bob.session.topHash).toBe(alice.session.topHash);
  });

  it("an admin who handed the role on and signs another history halts the group", async () => {
    const { net, alice, bob, carol, mallory } = await group();
    const before = alice.session.top, beforeRoster = alice.session.roster;
    await alice.session.transferAdmin(bob.session.myKey);
    await net.settle();
    await bob.session.remove(mallory.session.myKey);
    await net.settle();
    expect(carol.session.admin).toBe(bob.session.myKey);
    // Alice, admin before the hand-over, signs a rotation on another branch from there: two histories.
    const race = forge(carol, before, beforeRoster, { k: "add", s: createIdentity().pubKeyZ32 });
    const other = forge(alice, race.commit, race.roster, { k: "rotate" }).commit;
    expect(await carol.session.handle(bob.session.myKey, commitFrame(race.commit))).toBe(true);
    expect(carol.session.status).toBe("active");
    await carol.session.handle(alice.session.myKey, commitFrame(other));
    expect(carol.session.status).toBe("forked");
    expect(carol.session.state.statusReason).toMatch(/admin signed changes on two branches/);
  });

  it("a stored branch from before the fix that dropped an admin change is dropped in turn", async () => {
    const { net, alice, bob, mallory } = await group();
    const before = alice.session.top, beforeRoster = alice.session.roster;
    await alice.session.remove(mallory.session.myKey);
    await net.settle();
    const adminTip = alice.session.topHash;
    // Bob, under the old rule, followed Mallory's longer branch and kept the admin's removal off it.
    const branch = addBranch(mallory, before, beforeRoster, 3);
    const state = clone(bob.saved);
    const removal = state.chain.pop()!;
    state.chain.push(...clone(branch));
    state.side = [removal];
    state.seqH = communityCommitHash(branch[2]);
    bob.saved = state;
    // Restarted on this version, he follows the admin's branch again.
    await net.restart(bob);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bob.session.topHash).toBe(adminTip);
    expect(bob.session.status).toBe("active");
    expect(bob.session.roster.map(([k]) => k)).not.toContain(mallory.session.myKey);
  });
});
