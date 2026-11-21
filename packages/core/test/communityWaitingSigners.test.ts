import { describe, expect, it } from "vitest";
import { randomBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunityMessageFrame, type CommunitySessionHooks,
} from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * A message under a commit a member does not have yet waits for it. One signed by a key no commit it knows names (a
 * newcomer whose admission has not come yet, or a key made up) waits in a few places of its own: it neither pushes out
 * what members wrote nor keeps the member asking for a catch-up.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface Member { name: string; session: CommunitySession; online: boolean; paused: boolean; held: { from: string; frame: CommunityFrame }[]; texts: string[] }

/** Members on one network; what reaches a member while `paused` is held, to be handed in the order a test picks. */
class Net {
  readonly members = new Map<string, Member>();
  now = 1_000_000;
  private pending: Promise<unknown>[] = [];
  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame): boolean => {
      if (!to || !to.online || !member.online || to === member) return false;
      if (to.paused) to.held.push({ from: member.session.myKey, frame: clone(frame) });
      else this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
      return true;
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: m => { member.texts.push(m.text); },
      changed: () => {},
      clock: () => this.now,
      handled: async () => true,
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, session: (m: Member) => CommunitySession): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, paused: false, held: [], texts: [] };
    this.members.set(name, member);
    member.session = session(member);
    return member;
  }
  create(name: string): Member { return this.add(name, m => new CommunitySession(CommunitySession.create("Ghosts"), this.hooks(m))); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32, this.now);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, m => new CommunitySession(joined.state, this.hooks(m)));
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const batch = this.pending.splice(0);
      if (!batch.length) { await new Promise(r => setTimeout(r, 0)); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
}

async function say(net: Net, member: Member, text: string): Promise<void> {
  const sent = await member.session.sendText(text, member.name, net.now++);
  if ("error" in sent) throw new Error(sent.error);
  await net.settle();
}

/** A message signed by a key it made up, for a commit nobody has: well formed, and its signature holds. */
function madeUp(session: CommunitySession, e: number): { from: string; frame: CommunityMessageFrame } {
  const id = createIdentity();
  const unsigned = { g: session.id, e, h: Array.from(randomBytes(8), b => b.toString(16).padStart(2, "0")).join(""), s: id.pubKeyZ32, n: 0, ts: 1_000_000, nn: toBase64Url(randomBytes(24)), c: toBase64Url(randomBytes(64)) };
  const signed = utf8Encode(JSON.stringify(["ghostly-group/2 msg", unsigned.g, unsigned.e, unsigned.h, unsigned.s, unsigned.n, unsigned.ts, unsigned.nn, unsigned.c]));
  return { from: id.pubKeyZ32, frame: { t: "group-msg", v: 2, ...unsigned, sig: toBase64Url(sign(signed, id.seed)) } };
}

/** Hands Carol what she held: the messages first, then `flood` made-up ones, then the rest (commits, secrets). */
async function handHeld(net: Net, carol: Member, flood: number): Promise<void> {
  const held = carol.held.splice(0);
  carol.paused = false;
  for (const { from, frame } of held) if (frame.t === "group-msg") await carol.session.handle(from, frame);
  for (let i = 0; i < flood; i++) { const { from, frame } = madeUp(carol.session, carol.session.epoch + 1); await carol.session.handle(from, frame); }
  for (const { from, frame } of held) if (frame.t !== "group-msg") await carol.session.handle(from, frame);
  await net.settle();
}

describe("a community message waiting for its commit, by who signed it", { timeout: 60_000 }, () => {
  it("one made-up signer's message does not keep a member that lacks nothing asking for a catch-up", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const carol = await net.admit(alice, "Carol");
    await say(net, alice, "hello");
    expect(carol.session.needsCatchUp).toBe(false);
    const { from, frame } = madeUp(carol.session, carol.session.epoch + 1);
    expect(await carol.session.handle(from, frame)).toBe(false);
    expect(carol.session.needsCatchUp).toBe(false);
    net.now += 3_600_000;
    expect(carol.session.needsCatchUp).toBe(false);
  });

  for (const flood of [0, COMMUNITY_LIMITS.waiting]) {
    it(`a member's line under a commit not come yet waits through ${flood} made-up ones and lands when it comes`, async () => {
      const net = new Net();
      const alice = net.create("Alice");
      const bob = await net.admit(alice, "Bob");
      const carol = await net.admit(alice, "Carol");
      await net.settle();
      carol.paused = true;
      await alice.session.rotate(net.now);
      await net.settle();
      await say(net, bob, "Bob after the rotate");
      // Nobody else to ask: what Carol has is what she was handed.
      alice.online = false; bob.online = false;
      await handHeld(net, carol, flood);
      expect(carol.session.epoch).toBe(alice.session.epoch);
      expect(carol.texts).toContain("Bob after the rotate");
      expect(carol.session.needsCatchUp).toBe(false);
    });
  }

  it("a newcomer's line that comes before its admission still waits and lands, through a flood", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const carol = await net.admit(alice, "Carol");
    await net.settle();
    carol.paused = true;
    const dave = await net.admit(alice, "Dave");
    await net.settle();
    await say(net, dave, "Dave's first");
    alice.online = false; dave.online = false;
    const held = carol.held.splice(0);
    carol.paused = false;
    for (let i = 0; i < COMMUNITY_LIMITS.waiting; i++) { const { from, frame } = madeUp(carol.session, carol.session.epoch + 1); await carol.session.handle(from, frame); }
    for (const { from, frame } of held) if (frame.t === "group-msg") await carol.session.handle(from, frame);
    for (const { from, frame } of held) if (frame.t !== "group-msg") await carol.session.handle(from, frame);
    await net.settle();
    expect(carol.texts).toContain("Dave's first");
    expect(carol.session.needsCatchUp).toBe(false);
  });
});
