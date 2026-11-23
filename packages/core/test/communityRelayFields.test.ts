import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunityLeaveFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.protocol.community-topology

/*
 * What a community hub hands on of a frame it took is what it checked and keeps of it: the signed fields alone. Keys put
 * beside them by whoever handed it over (outside every signature, and outside a commit's hash, so the first copy to
 * reach a hub would be the one flooded) are dropped, for commits (outer frame and commit), metadata (also one that
 * waited for its commit), leaves and leave marks, as for messages.
 */

const MINUTE = 60_000;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const PAD = "x".repeat(2048);

interface Member { name: string; session: CommunitySession; key: string; hub: boolean; padIn: boolean }

/**
 * Members on explicit edges; a hub hands on what its session took (`passOn`) to every other edge, as the engine does. A
 * member with `padIn` gets every frame with extra keys beside the frame's own (and its commit's). `hold`: frames kept
 * off the wire until `release`.
 */
class Net {
  readonly members = new Map<string, Member>();
  now = Date.UTC(2026, 10, 23, 12);
  private readonly edges = new Set<string>();
  private pending: Promise<unknown>[] = [];
  readonly tap: { from: string; to: string; frame: Record<string, unknown> }[] = [];
  hold?: (from: Member, to: Member, frame: Record<string, unknown>) => boolean;
  private held: [Member, Member, Record<string, unknown>][] = [];
  mesh = true;

  private hooks(name: string): CommunitySessionHooks {
    const me = () => this.members.get(name)!;
    const send = (to: Member | undefined, frame: CommunityFrame | object) => {
      if (!to || to === me() || !this.linked(me(), to)) return false;
      this.deliver(me(), to, frame);
      return true;
    };
    return {
      save: async () => {},
      broadcast: frame => [...this.members.values()].filter(m => send(m, frame)).length,
      direct: (to, frame) => { send(this.byKey(to), frame); },
      addressed: (to, frame) => { send(this.byKey(to), frame); },
      relay: frame => { if (me().hub) for (const m of this.members.values()) send(m, frame); },
      message: () => {},
      changed: () => {},
      clock: () => this.now,
    };
  }
  private deliver(from: Member, to: Member, frame: object): void {
    const copy = clone(frame) as Record<string, unknown>;
    if (to.padIn) {
      copy.pad = PAD;
      if (copy.commit && typeof copy.commit === "object") (copy.commit as Record<string, unknown>).pad = PAD;
    }
    if (this.hold?.(from, to, copy)) { this.held.push([from, to, copy]); return; }
    this.tap.push({ from: from.name, to: to.name, frame: copy });
    this.pending.push((async () => {
      const fresh = await to.session.handle(from.key, copy);
      if (!fresh || !to.hub) return;
      const out = to.session.passOn(copy);
      for (const other of this.members.values()) if (other !== from && other !== to && this.linked(to, other)) this.deliver(to, other, out);
    })());
  }
  async release(): Promise<void> {
    this.hold = undefined;
    for (const [from, to, frame] of this.held.splice(0)) {
      this.tap.push({ from: from.name, to: to.name, frame });
      this.pending.push((async () => {
        const fresh = await to.session.handle(from.key, frame);
        if (!fresh || !to.hub) return;
        const out = to.session.passOn(frame);
        for (const other of this.members.values()) if (other !== from && other !== to && this.linked(to, other)) this.deliver(to, other, out);
      })());
    }
    await this.settle();
  }
  private linked(a: Member, b: Member): boolean { return this.mesh || this.edges.has([a.name, b.name].sort().join("|")); }
  link(...pairs: [Member, Member][]): void { this.mesh = false; this.edges.clear(); for (const [a, b] of pairs) this.edges.add([a.name, b.name].sort().join("|")); }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.key === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, key: "", hub: false, padIn: false };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    member.key = member.session.myKey;
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Relay", this.now)); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32, this.now);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64, this.now);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 100 && this.pending.length; i++) await Promise.all(this.pending.splice(0));
  }
  /** What `who` handed on, by frame kind. */
  sentBy(who: Member, t: string) { return this.tap.filter(x => x.from === who.name && x.frame.t === t).map(x => x.frame); }
}

/** Alice (admin), Hub, Bob and Dave; after the admissions each reaches the others through Hub only, and Hub gets every frame padded. */
async function community() {
  const net = new Net();
  const alice = net.create("Alice");
  const hub = await net.admit(alice, "Hub");
  const bob = await net.admit(alice, "Bob");
  const dave = await net.admit(alice, "Dave");
  await net.settle();
  hub.hub = true;
  hub.padIn = true;
  net.link([alice, hub], [bob, hub], [hub, dave]);
  net.now += MINUTE;
  return { net, alice, hub, bob, dave };
}

const noPad = (frames: Record<string, unknown>[]) => frames.every(f => !JSON.stringify(f).includes(PAD));

describe("a community hub hands on the signed fields alone", () => {
  it("of a metadata statement", async () => {
    const { net, alice, hub, dave } = await community();
    await alice.session.rename("Renamed", net.now);
    await net.settle();
    const out = net.sentBy(hub, "group-meta");
    expect(out.length).toBeGreaterThan(0);
    expect(noPad(out)).toBe(true);
    expect(dave.session.name).toBe("Renamed");
  });

  it("of a leave, the commit that takes it in and its mark", async () => {
    const { net, alice, hub, bob } = await community();
    await bob.session.leave();
    await net.settle();
    const leaves = net.sentBy(hub, "group-leave");
    expect(leaves.length).toBeGreaterThan(0);
    expect(noPad(leaves)).toBe(true);
    expect(Object.keys(leaves[0]).sort()).toEqual(["g", "ls", "ls3", "s", "t", "v"]);
    await alice.session.commitPendingLeaves(net.now);
    await net.settle();
    const commits = net.sentBy(hub, "group-commit"), lefts = net.sentBy(hub, "group-left");
    expect(commits.length).toBeGreaterThan(0);
    expect(lefts.length).toBeGreaterThan(0);
    expect(noPad(commits)).toBe(true);
    expect(noPad(lefts)).toBe(true);
    expect(Object.keys(lefts[0]).sort()).toEqual(["g", "h", "hi", "sig", "t", "v"]);
    // The hub took them as they came, padded: what it handed on is what it took.
    expect(hub.session.roster.some(([k]) => k === bob.key)).toBe(false);
  });

  it("of a metadata statement that waited for its commit", async () => {
    const { net, alice, hub } = await community();
    // The commit that admits Eve reaches Hub after the name Alice signs under it.
    net.hold = (from, to, f) => from === alice && to === hub && f.t === "group-commit";
    await net.admit(alice, "Eve");
    await alice.session.rename("After Eve", net.now);
    await net.settle();
    expect(net.sentBy(hub, "group-meta")).toEqual([]);
    await net.release();
    const out = net.sentBy(hub, "group-meta");
    expect(out.length).toBeGreaterThan(0);
    expect(noPad(out)).toBe(true);
    expect(noPad(net.sentBy(hub, "group-commit"))).toBe(true);
  });
});

describe("a leave request's admission statement", () => {
  it("is kept only once it holds: one in the shape of a signature does not take the place of the member's own", async () => {
    const { net, hub, bob } = await community();
    net.link([bob, hub]);
    hub.padIn = false;
    const own = (await bob.session.leave()) as CommunityLeaveFrame;
    await net.settle();
    expect(own.ls3).toBeDefined();
    // A fresh hub hears it first from a member who swapped the statement for one of the same shape.
    const other = new CommunitySession(clone(hub.session.state), {
      save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {}, clock: () => net.now,
    });
    other.state.pendingLeaves = [];
    const forged = { ...own, ls3: own.ls3!.slice(0, -2) + (own.ls3!.endsWith("AA") ? "BA" : "AA") };
    expect(await other.handle(hub.key, clone(forged))).toBe(true);
    expect(other.state.pendingLeaves.find(r => r.s === bob.key)?.ls3).toBeUndefined();
    expect((other.passOn(clone(forged)) as Record<string, unknown>).ls3).toBeUndefined();
    expect(await other.handle(bob.key, clone(own))).toBe(true);
    expect(other.state.pendingLeaves.find(r => r.s === bob.key)?.ls3).toBe(own.ls3);
  });
});
