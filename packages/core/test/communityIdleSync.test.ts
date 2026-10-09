import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityEntryFrame, type CommunityFrame, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * Every member syncs up to 3 of its edges every 30 s, so a hub answers a sync from each member it carries every 30 s,
 * nearly all from members that miss nothing. Such an answer walked the whole store, hashing commits to place each of
 * the 256 frames before seeing the member had it, and sealed the link's seed afresh: ~4 ms of main thread per answer
 * (2026-10-08).
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member { session: CommunitySession }

class Net {
  readonly members: Member[] = [];
  private pending: Promise<unknown>[] = [];
  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      if (to && to !== member) this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: () => {}, changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { return this.members.find(m => m.session.myKey === key); }
  private add(state: CommunityState): Member {
    const member: Member = { session: null as unknown as CommunitySession };
    this.members.push(member);
    member.session = new CommunitySession(state, this.hooks(member));
    return member;
  }
  create(): Member { return this.add(CommunitySession.create("Ghosts")); }
  async admit(by: Member): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

describe("a hub answering the sync of a member that misses nothing", { timeout: 120_000 }, () => {
  it("does not place the stored frames the member has, nor seal the link's seed again", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    // Everyone online while the store fills: Bob has every frame.
    const speakers = [alice, bob, carol];
    for (let i = 0; i < 300; i++) {
      const sent = await speakers[i % 3].session.sendText(`${i}`, "x", 1_000 + i);
      if ("error" in sent) throw new Error(sent.error);
      await net.settle();
    }
    expect(alice.session.state.store).toHaveLength(COMMUNITY_LIMITS.store);
    const sent: CommunityFrame[] = [];
    const hub = new CommunitySession(clone(alice.session.state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; },
    });
    const sync = clone(bob.session.syncFrame());
    await hub.handle(bob.session.myKey, clone(sync));
    const placed = vi.spyOn(hub, "commitByShort"), removed = vi.spyOn(hub, "wasRemoved");
    await hub.handle(bob.session.myKey, clone(sync));
    // Nothing to place: Bob has every frame the store holds.
    expect(placed).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    const entries = sent.filter((f): f is CommunityEntryFrame => f.t === "group-entry");
    expect(sent.filter(f => f.t === "group-msg")).toHaveLength(0);
    expect(entries).toHaveLength(2);
    // The seed sealed once to Bob, and what goes is still a seed Bob opens.
    expect(entries[1]).toEqual(entries[0]);
    const lost = new CommunitySession({ ...clone(bob.session.state), entry: { key: bob.session.state.entry.key, seedB64: "" } }, {
      save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {},
    });
    expect(await lost.handle(alice.session.myKey, clone(entries[1]))).toBe(true);
    expect(lost.state.entry.seedB64).toBe(alice.session.state.entry.seedB64);
  });

  it("a member that lacks frames is still handed them", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    const behind = clone(bob.session.syncFrame());
    for (let i = 0; i < 5; i++) {
      const sent = await carol.session.sendText(`${i}`, "x", 1_000 + i);
      if ("error" in sent) throw new Error(sent.error);
      await net.settle();
    }
    const sent: CommunityFrame[] = [];
    const hub = new CommunitySession(clone(alice.session.state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; },
    });
    await hub.handle(bob.session.myKey, behind);
    expect(sent.filter(f => f.t === "group-msg")).toHaveLength(5);
  });
});
