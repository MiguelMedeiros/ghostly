import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * A member's `have` was one high number per author and epoch, saved with the profile. A live frame of an author raises
 * it above that author's frames still coming in a catch-up answer; when the rest of the answer never arrived (the
 * member's app closed or its edge dropped mid catch-up, or the hub's app closed), they were below `have` in every later
 * sync, to that hub or any other, and lost for good. `have` now stops below the lowest number missing, so a cut answer
 * is asked for again; a gap nobody fills is asked for a few times only.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface Member { name: string; session: CommunitySession; online: boolean; texts: string[]; state?: CommunityState }

/** Members on one network, catch-up answers paced by `step` (the member's app handled what came) or cut (`cutHandled`). */
class Net {
  readonly members = new Map<string, Member>();
  readonly sent: { to: string; frame: CommunityFrame }[] = [];
  now = 1_000_000;
  private waitingHandled: ((handled: boolean) => void)[] = [];
  private pending: Promise<unknown>[] = [];
  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame): boolean => {
      if (!to || !to.online || !member.online || to === member) return false;
      this.sent.push({ to: to.name, frame });
      this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
      return true;
    };
    return {
      save: async state => { member.state = clone(state); },
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: m => { member.texts.push(m.text); },
      changed: () => {},
      clock: () => this.now,
      handled: () => new Promise<boolean>(resolve => { this.waitingHandled.push(resolve); }),
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, texts: [] };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(member));
    return member;
  }
  /** The app starts again from what it saved: the answers it was sending or taking are gone. */
  async reopen(member: Member): Promise<void> {
    await member.session.flush();
    member.session = new CommunitySession(clone(member.state ?? member.session.state), this.hooks(member));
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
      if (!batch.length) { await new Promise(r => setTimeout(r, 0)); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
  async step(): Promise<void> {
    for (const resolve of this.waitingHandled.splice(0)) resolve(true);
    await this.settle();
  }
  /** The member's app answers nothing more: the hub's answer stops at the next frame its edge does not take. */
  async cutHandled(): Promise<void> {
    for (const resolve of this.waitingHandled.splice(0)) resolve(false);
    await this.settle();
  }
}

async function say(net: Net, member: Member, text: string): Promise<void> {
  const sent = await member.session.sendText(text, member.name, net.now++);
  if ("error" in sent) throw new Error(sent.error);
  await net.settle();
}

/** Bob's syncs to Alice and Carol every 30 s, `rounds` times, each answer handled. */
async function idleSyncs(net: Net, bob: Member, others: Member[], rounds: number): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    net.now += 30_000;
    for (const other of others) bob.session.catchUp(other.session.myKey);
    await net.settle();
    for (let i = 0; i < 40; i++) await net.step();
  }
}

type Cut = "member-closes" | "member-offline" | "hub-closes";

/**
 * Alice (the hub), Bob and Carol. Bob is away while Carol says 200; back, Alice answers his sync a slice at a time.
 * After two slices Carol says one more, live, and the catch-up is cut; a minute later the edges open again.
 */
async function liveThenCut(cut: Cut, live = true) {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  await net.settle();
  bob.online = false;
  for (let i = 0; i < 200; i++) await say(net, carol, `Carol ${i}`);
  bob.online = true;
  await alice.session.handle(bob.session.myKey, clone(bob.session.syncFrame(alice.session.myKey)));
  await net.settle();
  for (let i = 0; i < 2; i++) { net.now += 500; await net.step(); }
  if (live) await say(net, carol, "Carol live");
  const beforeCut = bob.texts.length;
  const cutOff = cut === "hub-closes" ? alice : bob;
  cutOff.online = false;
  await net.cutHandled();
  net.now += 60_000;
  if (cut !== "member-offline") await net.reopen(cutOff);
  cutOff.online = true;
  // The edges open again: Bob's sync to Alice, then to Carol (each edge's first).
  net.now += 6_000;
  await alice.session.handle(bob.session.myKey, clone(bob.session.syncFrame(alice.session.myKey)));
  await net.settle();
  await carol.session.handle(bob.session.myKey, clone(bob.session.syncFrame(carol.session.myKey)));
  await net.settle();
  for (let i = 0; i < 100; i++) { net.now += 500; await net.step(); }
  await idleSyncs(net, bob, [alice, carol], 3);
  const missing = Array.from({ length: 200 }, (_, i) => `Carol ${i}`).filter(t => !bob.texts.includes(t));
  return { beforeCut, missing: missing.length, live: bob.texts.includes("Carol live"), once: new Set(bob.texts).size === bob.texts.length };
}

describe("a community catch-up cut after a live frame of an author whose missed frames were still coming", { timeout: 120_000 }, () => {
  for (const cut of ["member-closes", "member-offline", "hub-closes"] as Cut[]) {
    it(`${cut}: every missed message comes once an edge opens again`, async () => {
      const r = await liveThenCut(cut);
      expect(r.beforeCut).toBeLessThan(100);
      expect(r).toMatchObject({ missing: 0, live: true, once: true });
    });
  }

  it("with no live frame, the same cut: every missed message comes (as before)", async () => {
    expect(await liveThenCut("member-closes", false)).toMatchObject({ missing: 0, once: true });
  });

  it("a gap no member can fill (the store rolled past it) is asked for a few times, then no more", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const dave = await net.admit(alice, "Dave");
    await net.settle();
    bob.online = false;
    // 600 frames, Carol's and Dave's in turn: the stores keep the last 256, so Bob's window of Carol's numbers (the
    // last 256 below her highest) holds 128 that nobody has any more.
    for (let i = 0; i < 300; i++) { await say(net, carol, `Carol ${i}`); await say(net, dave, `Dave ${i}`); }
    bob.online = true;
    await alice.session.handle(bob.session.myKey, clone(bob.session.syncFrame(alice.session.myKey)));
    await net.settle();
    for (let i = 0; i < 40; i++) { net.now += 500; await net.step(); }
    expect(bob.texts).toHaveLength(COMMUNITY_LIMITS.store);
    expect(bob.session.missing(carol.session.myKey)).toBe(128);
    const handedToBob = () => net.sent.filter(x => x.to === "Bob" && x.frame.t === "group-msg").length;
    const counts: number[] = [];
    for (let r = 0; r < 8; r++) { const from = handedToBob(); await idleSyncs(net, bob, [alice], 1); counts.push(handedToBob() - from); }
    // Carol's stored 128 again for the first syncs, then nothing: the gap is given up.
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts.filter(n => n > 0).length).toBeLessThanOrEqual(3);
    expect(counts.slice(-4)).toEqual([0, 0, 0, 0]);
    // A frame of Carol's lost later, above the given-up gap, is still asked for.
    bob.online = false;
    await say(net, carol, "Carol later");
    bob.online = true;
    await say(net, carol, "Carol after");
    await idleSyncs(net, bob, [alice], 1);
    expect(bob.texts).toEqual(expect.arrayContaining(["Carol later", "Carol after"]));
    expect(new Set(bob.texts).size).toBe(bob.texts.length);
  });
});
