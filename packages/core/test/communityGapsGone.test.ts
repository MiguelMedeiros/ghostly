// A gap a catch-up answer did not fill is gone once the answer is over: the members panel stops counting it.
import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
import { GROUP_HAVE_FRAME } from "../src/groupFiles";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface Member { session: CommunitySession; online: boolean; texts: string[] }

class Net {
  readonly members: Member[] = [];
  now = 1_000_000;
  private pending: Promise<unknown>[] = [];
  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      if (!to || !to.online || !member.online || to === member) return false;
      this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
      return true;
    };
    return {
      save: async () => {},
      broadcast: frame => this.members.filter(m => deliver(m, frame)).length,
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => { deliver(this.byKey(to), frame); },
      message: m => { member.texts.push(m.text); },
      changed: () => {},
      app: () => {},
      fleeting: frame => frame.t === GROUP_HAVE_FRAME,
      clock: () => this.now,
    };
  }
  private byKey(key: string) { return this.members.find(m => m.session.myKey === key); }
  private add(state: CommunityState): Member {
    const member: Member = { session: null as unknown as CommunitySession, online: true, texts: [] };
    this.members.push(member);
    member.session = new CommunitySession(state, this.hooks(member));
    return member;
  }
  create() { return this.add(CommunitySession.create("Ghosts")); }
  async admit(by: Member) {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(joined.state);
  }
  async settle() { for (let i = 0; i < 400; i++) { const b = this.pending.splice(0); if (!b.length) break; await Promise.all(b); } }
}

describe("community gaps nobody holds", () => {
  it("a hint said while I was away is not counted missing once the catch-up answer is over", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), dave = await net.admit(alice);
    await net.settle();
    await bob.session.sendText("before", "Bob", 1_000);
    await net.settle();
    dave.online = false;
    // A hint is relayed live and never kept (WISP 903): its number is a gap no catch-up fills.
    await bob.session.sendApp({ t: GROUP_HAVE_FRAME, ids: ["x"] }, "Bob", 1_001);
    await bob.session.sendText("after", "Bob", 1_002);
    await net.settle();
    dave.online = true;
    dave.session.catchUp(alice.session.myKey);
    await net.settle();
    expect(dave.texts).toEqual(["before", "after"]);
    // Still answering: the gap may be on its way.
    expect(dave.session.missing(bob.session.myKey)).toBe(1);
    net.now += 6_000;
    expect(dave.session.missing(bob.session.myKey)).toBe(0);
    expect(alice.session.missing(bob.session.myKey)).toBe(0);
  });

  it("a gap that comes live after the answer is over is counted until it arrives", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), dave = await net.admit(alice);
    await net.settle();
    await bob.session.sendText("one", "Bob", 1_000);
    await net.settle();
    dave.online = false;
    await bob.session.sendApp({ t: GROUP_HAVE_FRAME, ids: ["x"] }, "Bob", 1_001);
    await bob.session.sendText("two", "Bob", 1_002);
    await net.settle();
    dave.online = true;
    dave.session.catchUp(alice.session.myKey);
    await net.settle();
    net.now += 6_000;
    expect(dave.session.missing(bob.session.myKey)).toBe(0);
    // Bob's next text reaches Dave, the one before it does not (yet): that gap is after the answer, still on its way.
    dave.online = false;
    await bob.session.sendText("three", "Bob", 1_003);
    await net.settle();
    dave.online = true;
    await bob.session.sendText("four", "Bob", 1_004);
    await net.settle();
    expect(dave.session.missing(bob.session.myKey)).toBe(1);
    net.now += 6_000;
    expect(dave.session.missing(bob.session.myKey)).toBe(1);
    // Until the next answer: my sync says what I have below that gap (`haveOf`), so it hands it.
    dave.session.catchUp(alice.session.myKey);
    await net.settle();
    expect(dave.texts).toEqual(["one", "two", "four", "three"]);
    expect(dave.session.missing(bob.session.myKey)).toBe(0);
    net.now += 6_000;
    expect(dave.session.missing(bob.session.myKey)).toBe(0);
  });

  it("a gap the syncs gave up is not counted missing", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), dave = await net.admit(alice);
    await net.settle();
    await bob.session.sendText("one", "Bob", 1_000);
    await net.settle();
    dave.online = false;
    await bob.session.sendText("two", "Bob", 1_001);
    await net.settle();
    dave.online = true;
    await bob.session.sendText("three", "Bob", 1_002);
    await net.settle();
    // Alice is away: no answer comes, so none settles the gap; the syncs that asked for it give it up (`haveOf`).
    alice.online = false;
    const counts: number[] = [];
    for (let i = 0; i < 6; i++) {
      dave.session.catchUp(alice.session.myKey);
      await net.settle();
      net.now += 6_000;
      counts.push(dave.session.missing(bob.session.myKey));
    }
    expect(dave.texts).toEqual(["one", "three"]);
    // Given up, it is no more on its way than one a finished answer did not fill.
    expect(counts).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("a sync nobody answered settles nothing", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), dave = await net.admit(alice);
    await net.settle();
    await bob.session.sendText("one", "Bob", 1_000);
    await net.settle();
    dave.online = false;
    await bob.session.sendText("two", "Bob", 1_001);
    await net.settle();
    dave.online = true;
    await bob.session.sendText("three", "Bob", 1_002);
    await net.settle();
    expect(dave.session.missing(bob.session.myKey)).toBe(1);
    // Alice is away: Dave's sync goes nowhere, and "two" is still on its way.
    alice.online = false;
    dave.session.catchUp(alice.session.myKey);
    await net.settle();
    net.now += 6_000;
    expect(dave.session.missing(bob.session.myKey)).toBe(1);
  });
});
