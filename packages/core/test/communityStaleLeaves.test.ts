import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * Only hubs commit leaves, and committing was the one place a held request went. Every other member kept each request
 * it heard after the leave was committed and the member was out, up to 64 of them, and handed all of them again in
 * every catch-up answer: after 64 join+leave cycles, 64 `group-leave` frames (16 KB) in each answer to a member who
 * misses nothing, for members a receiver drops at once. A request now goes once the branch I follow takes its member
 * out, and an answer carries only requests whose member is still in.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean }
interface Sent { from: string; to: string; t: string; bytes: number }

/** Members on one network: what someone broadcasts reaches every online member; every frame delivered is counted. */
class Net {
  readonly members = new Map<string, Member>();
  readonly sent: Sent[] = [];
  readonly leaves: CommunityFrame[] = [];
  private pending: Promise<unknown>[] = [];

  hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      const t = String((frame as { t?: unknown }).t);
      this.sent.push({ from: name, to: to.name, t, bytes: JSON.stringify(frame).length });
      if (t === "group-leave") this.leaves.push(clone(frame));
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
  add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true };
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
  /** The frames `from` hands `to` in answer to one catch-up ask. */
  async answer(from: Member, to: Member): Promise<Sent[]> {
    await this.settle();
    const start = this.sent.length;
    to.session.catchUp(from.session.myKey);
    await this.settle();
    return this.sent.slice(start).filter(s => s.from === from.name && s.to === to.name);
  }
}

const CYCLES = 70;

/** Alice (the admin, who commits), Bob and Carol (who never do); then `CYCLES` joiners let in, one text each, and their leave committed by Alice. */
async function churn() {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  await net.settle();
  for (let i = 0; i < CYCLES; i++) {
    const joiner = await net.admit(alice, `J${i}`);
    await net.settle();
    await joiner.session.sendText(`hi ${i}`);
    await joiner.session.leave();
    await net.settle();
    joiner.online = false;
    expect(await alice.session.commitPendingLeaves()).toBe(1);
    await net.settle();
  }
  return { net, alice, bob, carol };
}

describe("a member who does not commit leaves holds no request for someone already out", { timeout: 120_000 }, () => {
  it(`after ${CYCLES} join+leave cycles: no request held, and no group-leave in a catch-up answer`, async () => {
    const { net, alice, bob, carol } = await churn();
    for (const m of [alice, bob, carol]) {
      expect(m.session.roster.length, m.name).toBe(3);
      expect(m.session.state.pendingLeaves.length, m.name).toBe(0);
    }
    // Bob answers Carol, who misses nothing, as Alice does: no leave for a member already out.
    const fromBob = await net.answer(bob, carol), fromAlice = await net.answer(alice, carol);
    expect(fromBob.filter(s => s.t === "group-leave")).toEqual([]);
    expect(fromBob.length).toBe(fromAlice.length);
  });

  it("a record that still holds such requests (saved by an earlier version) hands none of them on", async () => {
    const { net, alice, bob, carol } = await churn();
    const stale = net.leaves.map(f => { const { s, ls, ls3 } = f as { s: string; ls: string; ls3?: string }; return { s, ls, ...(ls3 ? { ls3 } : {}) }; });
    const unique = [...new Map(stale.map(r => [r.s, r])).values()].slice(-64);
    expect(unique.length).toBe(64);
    // Bob's app reopens its record as an earlier version saved it.
    const saved = clone(bob.session.state);
    saved.pendingLeaves = unique;
    net.members.delete("Bob");
    const reopened = net.add("Bob", saved);
    const fromBob = await net.answer(reopened, carol), fromAlice = await net.answer(alice, carol);
    expect(fromBob.filter(s => s.t === "group-leave")).toEqual([]);
    expect(fromBob.length).toBe(fromAlice.length);
  });

  it("a request for a member still in is held and handed on, as before", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const dave = await net.admit(alice, "Dave");
    await net.settle();
    alice.online = false;
    await dave.session.leave(); await net.settle();
    dave.online = false;
    expect(bob.session.state.pendingLeaves.map(r => net.byKey(r.s)?.name)).toEqual(["Dave"]);
    // A commit that does not take Dave out keeps the request.
    alice.online = true;
    await alice.session.rotate(); await net.settle();
    expect(bob.session.state.pendingLeaves.map(r => net.byKey(r.s)?.name)).toEqual(["Dave"]);
    const fromBob = await net.answer(bob, carol);
    expect(fromBob.filter(s => s.t === "group-leave").length).toBe(1);
    // Alice hears it in Bob's answer; once she commits it, Bob and Carol drop it.
    await net.answer(bob, alice);
    expect(await alice.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    for (const m of [bob, carol]) expect(m.session.state.pendingLeaves, m.name).toEqual([]);
  });
});
