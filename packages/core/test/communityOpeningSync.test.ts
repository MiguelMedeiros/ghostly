import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * A member's edge to its hub comes up and both say where they are. The member answers the hub's sync with its own
 * question at the end, unless it asked the hub a moment ago: its sync at the edge's opening was not counted as asked,
 * so a second one went, and the hub's answer to it took the place of what was left of the first, from its start. A
 * member back after 256 messages was handed 288 message frames, the first slices twice (bug hunt, 2026-10-14).
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean }
interface Sent { from: string; to: string; frame: CommunityFrame }

/** Members on one network, each frame in order and a few ms apart; `sent` is every frame a member handed another. */
class Net {
  readonly members = new Map<string, Member>();
  readonly sent: Sent[] = [];
  private pending: Promise<unknown>[] = [];
  /** Per member, the frames it was handed still being handled, in order. */
  private queues = new Map<string, Promise<unknown>>();

  deliver(from: Member, to: Member | undefined, frame: CommunityFrame): boolean {
    if (!to || !to.online || !from.online || to === from) return false;
    this.sent.push({ from: from.name, to: to.name, frame });
    const done = (this.queues.get(to.name) ?? Promise.resolve()).then(() => sleep(1)).then(() => to.session.handle(from.session.myKey, clone(frame)));
    this.queues.set(to.name, done);
    this.pending.push(done);
    return true;
  }
  private hooks(name: string): CommunitySessionHooks {
    const me = () => this.members.get(name)!;
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) this.deliver(me(), m, frame); },
      direct: (to, frame) => this.deliver(me(), this.byKey(to), frame),
      addressed: (to, frame) => { this.deliver(me(), this.byKey(to), frame); },
      message: () => {},
      changed: () => {},
      // The member's app answers once it handled every frame handed to it so far.
      handled: async to => { await this.queues.get(this.byKey(to)?.name ?? ""); return true; },
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
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
    for (let i = 0; i < 400; i++) { const batch = this.pending.splice(0); if (!batch.length) { await sleep(20); if (!this.pending.length) break; } await Promise.all(batch); }
  }
}

describe("a community member back at its hub is answered once", { timeout: 120_000 }, () => {
  it("both sides' syncs at the edge's opening: no second sync, each message handed once (2026-10-14)", async () => {
    const net = new Net();
    const alice = await net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    await net.settle();
    // Bob's app is closed while Alice and Carol say 256 things.
    bob.online = false;
    for (let i = 0; i < COMMUNITY_LIMITS.store; i++) {
      const speaker = i % 2 ? carol : alice;
      const sent = await speaker.session.sendText(`${speaker.name} ${i}`, speaker.name, 1_000 + i);
      if ("error" in sent) throw new Error(sent.error);
    }
    await net.settle();
    // Bob's app opens and its edge to Alice comes up: each says where it is (the engine's `edgeReady`).
    bob.online = true;
    const from = net.sent.length;
    net.deliver(bob, alice, bob.session.syncFrame(alice.session.myKey));
    net.deliver(alice, bob, alice.session.syncFrame(bob.session.myKey));
    await net.settle();
    const after = net.sent.slice(from);
    const syncs = after.filter(s => s.from === "Bob" && s.to === "Alice" && s.frame.t === "group-sync").length;
    const messages = after.filter(s => s.from === "Alice" && s.to === "Bob" && s.frame.t === "group-msg").length;
    expect(bob.session.state.store).toHaveLength(COMMUNITY_LIMITS.store);
    expect({ syncs, messages }).toEqual({ syncs: 1, messages: COMMUNITY_LIMITS.store });
  });
});
