import { describe, expect, it } from "vitest";
import { fromBase64Url, utf8Encode } from "../src/bytes";
import { createIdentity, identityFromSeedB64, publicKeyFromZ32, verify } from "../src/identity";
import { COMMUNITY_LIMITS, CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.send, groups.protocol.community-topology

/*
 * Which of a community's messages came as they were written (`CommunityIncomingMessage.live`), so the app can tell the
 * author's clock by how long they took (WISP 903 § Relaying, revision 2026-11-03). A member's messages almost always
 * come through a hub, and nothing said whether a hub passed one on as it came or from a catch-up of its own: a member
 * whose clock ran over a minute behind was never heard. Now a hub that passes on at once a message that came live to it
 * marks its copy with its own key (`lv`), outside the author's signature, and a member reads the mark only from the
 * member that set it.
 */

const MINUTE = 60_000;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member { name: string; session: CommunitySession; key: string; hub: boolean; old: boolean; skew: number; got: CommunityIncomingMessage[] }

/**
 * Members on explicit edges. A hub hands on what its session took to every other edge, at once, as the engine does
 * (`Communities.handleEdgeFrame`): `passOn` adds its mark. An `old` hub (an app from before this revision) hands the
 * frame on as it came, a mark it was handed included. `tap`: every frame on the wire, by edge.
 */
class Net {
  readonly members = new Map<string, Member>();
  now = Date.UTC(2026, 10, 3, 12);
  private readonly edges = new Set<string>();
  private pending: Promise<unknown>[] = [];
  readonly tap: { from: string; to: string; frame: Record<string, unknown> }[] = [];
  mesh = true;

  private hooks(name: string): CommunitySessionHooks {
    const send = (to: Member | undefined, frame: CommunityFrame | object) => {
      const me = this.members.get(name)!;
      if (!to || to === me || !this.linked(me, to)) return false;
      this.deliver(me, to, frame);
      return true;
    };
    return {
      save: async () => {},
      broadcast: frame => [...this.members.values()].filter(m => send(m, frame)).length,
      direct: (to, frame) => { send(this.byKey(to), frame); },
      addressed: (to, frame) => { send(this.byKey(to), frame); },
      message: m => { this.members.get(name)!.got.push(m); },
      changed: () => {},
      clock: () => this.now + this.members.get(name)!.skew,
    };
  }
  private deliver(from: Member, to: Member, frame: object): void {
    const copy = clone(frame) as Record<string, unknown>;
    this.tap.push({ from: from.name, to: to.name, frame: copy });
    this.pending.push((async () => {
      const fresh = await to.session.handle(from.key, copy);
      if (!fresh || !to.hub) return;
      const out = to.old ? copy : to.session.passOn(copy);
      for (const other of this.members.values()) if (other !== from && other !== to && this.linked(to, other)) this.deliver(to, other, out);
    })());
  }
  private linked(a: Member, b: Member): boolean { return this.mesh || this.edges.has([a.name, b.name].sort().join("|")); }
  /** From now on, only these edges are up. */
  link(...pairs: [Member, Member][]): void { this.mesh = false; this.edges.clear(); for (const [a, b] of pairs) this.edges.add([a.name, b.name].sort().join("|")); }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.key === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, key: "", hub: false, old: false, skew: 0, got: [] };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    member.key = member.session.myKey;
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Clocks", this.now)); }
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
  /** `who` says `text`, dated by its own clock. */
  async say(who: Member, text: string, at = this.now + who.skew): Promise<void> {
    const sent = await who.session.sendText(text, who.name, at);
    if ("error" in sent) throw new Error(sent.error);
    await this.settle();
  }
}

/** Alice (admin), Hub, Bob (writes, his clock 90 s behind) and Dave (reads). After the admissions, Bob and Dave each reach Hub only. */
async function community() {
  const net = new Net();
  const alice = net.create("Alice");
  const hub = await net.admit(alice, "Hub");
  const bob = await net.admit(alice, "Bob");
  const dave = await net.admit(alice, "Dave");
  await net.settle();
  hub.hub = true;
  bob.skew = -90_000;
  net.link([bob, hub], [hub, dave]);
  net.now += MINUTE;
  return { net, alice, hub, bob, dave };
}
const liveOf = (m: Member, text: string) => m.got.find(g => g.text === text)?.live;

describe("a community message that came as it was written is live", () => {
  it("straight from its author's edge: live", async () => {
    const { net, bob, hub } = await community();
    await net.say(bob, "straight");
    expect(liveOf(hub, "straight")).toBe(true);
  });

  it("handed on at once by the hub, which marks it with its key: live, and the mark is neither kept nor stored", async () => {
    const { net, bob, hub, dave } = await community();
    await net.say(bob, "@Dave are you there?");
    expect(liveOf(dave, "@Dave are you there?")).toBe(true);
    const relayed = net.tap.find(t => t.from === "Hub" && t.to === "Dave" && t.frame.t === "group-msg")!;
    expect(relayed.frame.lv).toBe(hub.key);
    // Bob's own copy to the hub carries none: the mark is the hop's.
    expect(net.tap.find(t => t.from === "Bob" && t.to === "Hub" && t.frame.t === "group-msg")!.frame.lv).toBeUndefined();
    // What Dave keeps to hand on, and what its row holds, is the frame as Bob signed it.
    const kept = dave.got.find(g => g.text === "@Dave are you there?")!.frame!;
    expect("lv" in kept).toBe(false);
    expect(dave.session.state.store.some(f => "lv" in f)).toBe(false);
  });

  it("a marked frame still verifies as its author signed it, by the tuple apps from before check", async () => {
    const { net, bob, hub, dave } = await community();
    await net.say(bob, "marked");
    const relayed = net.tap.find(t => t.from === "Hub" && t.to === "Dave" && t.frame.t === "group-msg")!.frame as Record<string, string | number>;
    expect(relayed.lv).toBe(hub.key);
    // What an app up to 1.8.x verifies (WISP 903 § Messages and catch-up): the author's signature over these fields
    // alone. The mark is not among them, so the frame verifies with it as without it.
    const f = relayed;
    const signed = utf8Encode(JSON.stringify(["ghostly-group/2 msg", f.g, f.e, f.h, f.s, f.n, f.ts, f.nn, f.c]));
    expect(verify(fromBase64Url(f.sig as string), signed, publicKeyFromZ32(bob.key))).toBe(true);
    // A member that never saw it takes it, marked or not.
    const unseen = () => {
      const state = clone(dave.session.state);
      state.store = state.store.filter(x => x.s !== bob.key);
      delete state.seen[bob.key];
      const got: string[] = [];
      return { got, session: new CommunitySession(state, { save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: m => { got.push(m.text); }, changed: () => {} }) };
    };
    const marked = unseen(), plain = unseen();
    const { lv: _mark, ...unmarked } = relayed;
    expect(await marked.session.handle(hub.key, clone(relayed))).toBe(true);
    expect(await plain.session.handle(hub.key, unmarked)).toBe(true);
    expect([marked.got, plain.got]).toEqual([["marked"], ["marked"]]);
  });
});

describe("what is not known to be live stays as before", () => {
  it("a hub from before this revision marks nothing: not live", async () => {
    const { net, bob, hub, dave } = await community();
    hub.old = true;
    await net.say(bob, "through an old hub");
    expect(dave.got.map(g => g.text)).toContain("through an old hub");
    expect(liveOf(dave, "through an old hub")).toBeUndefined();
  });

  it("a mark another member set, handed on as it came by an old hub: not live", async () => {
    const { net, alice, bob, hub, dave } = await community();
    // Bob > Hub (marks) > Alice (an old hub: hands it on as it came) > Dave.
    alice.hub = true; alice.old = true;
    net.link([bob, hub], [hub, alice], [alice, dave]);
    await net.say(bob, "two hops");
    expect(net.tap.find(t => t.from === "Alice" && t.to === "Dave" && t.frame.t === "group-msg")!.frame.lv).toBe(hub.key);
    expect(dave.got.map(g => g.text)).toContain("two hops");
    expect(liveOf(dave, "two hops")).toBeUndefined();
  });

  it("two new hubs: each hands it on with its own mark, and it is live at the end", async () => {
    const { net, alice, bob, hub, dave } = await community();
    alice.hub = true;
    net.link([bob, hub], [hub, alice], [alice, dave]);
    await net.say(bob, "two new hops");
    expect(net.tap.find(t => t.from === "Alice" && t.to === "Dave" && t.frame.t === "group-msg")!.frame.lv).toBe(alice.key);
    expect(liveOf(dave, "two new hops")).toBe(true);
  });

  it("a hub that marks a message written long before it came: past the bound it is not live", async () => {
    const { net, bob, hub, dave } = await community();
    // Bob's message, said by his clock as written 30 minutes ago (as a hub caught up would hand on a frame it took late).
    await net.say(bob, "old news", net.now + bob.skew - 30 * MINUTE);
    expect(net.tap.find(t => t.from === "Hub" && t.to === "Dave" && t.frame.t === "group-msg")!.frame.lv).toBe(hub.key);
    expect(liveOf(dave, "old news")).toBeUndefined();
    // Within the bound it is (a clock that far behind is still told).
    await net.say(bob, "recent", net.now + bob.skew - COMMUNITY_LIMITS.liveMarkMs + 2 * MINUTE);
    expect(liveOf(dave, "recent")).toBe(true);
  });

  it("a mark that does not name the member it came from is no mark", async () => {
    const { net, bob, hub, dave } = await community();
    await net.say(bob, "named");
    const relayed = net.tap.find(t => t.from === "Hub" && t.to === "Dave" && t.frame.t === "group-msg")!.frame;
    const before = clone(dave.session.state);
    before.store = before.store.filter(f => f.s !== bob.key);
    delete before.seen[bob.key];
    const got: CommunityIncomingMessage[] = [];
    const fresh = new CommunitySession(before, { save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: m => { got.push(m); }, changed: () => {}, clock: () => net.now });
    // Handed by Alice, naming the hub.
    const alice = net.members.get("Alice")!;
    expect(await fresh.handle(alice.key, clone(relayed))).toBe(true);
    expect(relayed.lv).toBe(hub.key);
    expect(got.map(m => [m.text, m.live])).toEqual([["named", undefined]]);
  });

  it("the author's answer to my sync is a catch-up, not live; what it writes once the answer is over is", async () => {
    const { net, bob, hub } = await community();
    // The hub asks Bob (its edge just opened); Bob's next frames over that edge may be his answer.
    hub.session.syncFrame(bob.key);
    await net.say(bob, "in the answer window");
    expect(liveOf(hub, "in the answer window")).toBeUndefined();
    net.now += 10_000;
    await net.say(bob, "after it");
    expect(liveOf(hub, "after it")).toBe(true);
  });

  it("the hub's answer to my sync carries no mark: what Dave missed is not live", async () => {
    const { net, bob, hub, dave } = await community();
    net.link([bob, hub]);
    await net.say(bob, "while Dave was away");
    net.link([bob, hub], [hub, dave]);
    net.now += MINUTE;
    dave.session.catchUp(hub.key);
    await net.settle();
    expect(dave.got.map(g => g.text)).toContain("while Dave was away");
    expect(liveOf(dave, "while Dave was away")).toBeUndefined();
    expect(net.tap.filter(t => t.from === "Hub" && t.to === "Dave" && t.frame.t === "group-msg").every(t => t.frame.lv === undefined)).toBe(true);
  });
});
