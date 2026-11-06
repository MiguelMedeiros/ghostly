import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, communityCommitHash, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * A member stops being one at the commit that takes it out. A member's app that left and still follows the chain
 * (`followAfterLeave`, to pass the admin role on) took any secret sealed to it on a side branch from before that
 * commit, at its epoch or later, and a member answering its catch-up sealed it those: the roster of the side commit
 * still listed it. The main branch's removal now bounds every path, both ways.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean; heard: CommunityFrame[] }

/** Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does). */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      to.heard.push(clone(frame));
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
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, heard: [] };
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
  only(...online: Member[]): void { for (const m of this.members.values()) m.online = online.includes(m); }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const batch = this.pending.splice(0);
      if (!batch.length) { await sleep(0); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
}

/**
 * Alice (admin), Bob, Carol, Dave, Eve. Eve's leave reaches Dave alone. Then, with Dave away, Bob leaves and follows
 * the chain after (`leave(true)`, `followAfterLeave`), Carol commits his leave (epoch `out`) and lets Fred in on top.
 * Dave, still on the view from before, works on a branch where Bob is in.
 */
async function bobLeftDaveStale() {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  const dave = await net.admit(alice, "Dave");
  const eve = await net.admit(alice, "Eve");
  await net.settle();
  net.only(eve, dave);
  await eve.session.leave(); await net.settle();
  net.only(alice, bob, carol);
  await bob.session.leave(true); await net.settle();
  await bob.session.followAfterLeave();
  expect(await carol.session.commitPendingLeaves()).toBe(1);
  const out = carol.session.epoch;
  await carol.session.admit(createIdentity().pubKeyZ32); await net.settle();
  expect(bob.session.topHash).toBe(carol.session.topHash);
  expect(bob.session.roster.some(([k]) => k === bob.session.myKey)).toBe(false);
  return { net, alice, bob, carol, dave, eve, out };
}

const secretFrames = (m: Member, h: string) => m.heard.filter(f =>
  (f.t === "group-secret" && f.h === h) || (f.t === "group-secrets" && f.secrets.some(s => s.h === h)));

describe("a member's app that left takes no secret from the commit that took it out on", { timeout: 60_000 }, () => {
  it("a fresh secret sealed to it on a side branch at its removal's epoch is not taken (takeSecret)", async () => {
    const { net, bob, dave, out } = await bobLeftDaveStale();
    // Dave commits Eve's leave on his stale view: a fresh secret, sealed to everyone that roster lists, Bob too.
    net.only(bob, dave);
    expect(await dave.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    const side = dave.session.topHash;
    expect(dave.session.epoch).toBe(out);
    expect(secretFrames(bob, side)).toHaveLength(1);
    expect(bob.session.state.side.map(c => communityCommitHash(c))).toContain(side);
    expect(bob.session.state.secrets[side]).toBeUndefined();
  });

  it("a derived secret on a side branch at its removal's epoch is not taken (takeDerived)", async () => {
    const { net, bob, dave, out } = await bobLeftDaveStale();
    // Bob holds the secret of the epoch he left in; Dave's admission on his stale view derives from it.
    net.only(bob, dave);
    await dave.session.admit(createIdentity().pubKeyZ32); await net.settle();
    const side = dave.session.topHash;
    expect(dave.session.epoch).toBe(out);
    expect(bob.session.state.side.map(c => communityCommitHash(c))).toContain(side);
    expect(bob.session.state.secrets[side]).toBeUndefined();
  });

  it("a member answering its catch-up seals it no secret of a side branch at its removal's epoch (receiveSync)", async () => {
    const { net, bob, carol, dave, out } = await bobLeftDaveStale();
    // Dave commits Eve's leave on his stale view and writes on it; Carol hears both (the branch is shorter: she stays).
    net.only(carol, dave);
    expect(await dave.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    expect("id" in await dave.session.sendText("on the stale branch")).toBe(true);
    await net.settle();
    const side = dave.session.topHash;
    expect(dave.session.epoch).toBe(out);
    expect(carol.session.state.secrets[side]).toBeDefined();
    expect(carol.session.state.store.some(f => f.s === dave.session.myKey)).toBe(true);
    // Bob, following, asks Carol.
    net.only(bob, carol);
    bob.heard.length = 0;
    bob.session.catchUp(carol.session.myKey); await net.settle();
    expect(secretFrames(bob, side)).toEqual([]);
    expect(bob.session.state.secrets[side]).toBeUndefined();
  });

  it("the main branch's secrets from before the removal still reach it, and none from it on", async () => {
    const { net, bob, carol, out } = await bobLeftDaveStale();
    net.only(bob, carol);
    bob.heard.length = 0;
    // A sync from far back: the answer carries the main branch from there.
    const sync = { ...(bob.session as unknown as { syncFrame(to: string): Record<string, unknown> }).syncFrame(carol.session.myKey) };
    sync.h = communityCommitHash(carol.session.state.chain[0]); sync.secrets = [];
    await carol.session.handle(bob.session.myKey, sync); await net.settle();
    const sealed = bob.heard.flatMap(f => f.t === "group-secret" ? [f.h] : f.t === "group-secrets" ? f.secrets.map(s => s.h) : []);
    const epochOf = (h: string) => carol.session.state.chain.find(c => communityCommitHash(c) === h)!.e;
    expect(sealed.length).toBeGreaterThan(0);
    for (const h of sealed) expect(epochOf(h)).toBeLessThan(out);
  });
});
