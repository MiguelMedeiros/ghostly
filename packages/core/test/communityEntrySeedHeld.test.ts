import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import * as crypto from "../src/groupCrypto";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * Every sync answer carries the link's seed sealed to the member that asked (`group-entry`): from each hub it syncs
 * with, every 30 s. Opening it is an X25519, and taking it an Ed25519 key derivation; a member that holds the seed of
 * that key did both on every answer, for nothing (a quarter of an idle community's time, 2026-11-02).
 */

vi.mock("../src/groupCrypto", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/groupCrypto")>();
  return { ...actual, openSecret: vi.fn(actual.openSecret) };
});

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

describe("a community member handed the link's seed again", { timeout: 60_000 }, () => {
  it("does not open it when it holds that key's seed, and still takes a seed it lacks", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    const opened = vi.mocked(crypto.openSecret);
    const sent: CommunityFrame[] = [];
    const hub = new CommunitySession(clone(alice.session.state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; },
    });
    await hub.handle(bob.session.myKey, clone(bob.session.syncFrame()));
    const entry = sent.find(f => f.t === "group-entry");
    expect(entry).toBeDefined();
    expect(bob.session.state.entry.seedB64).toBe(alice.session.state.entry.seedB64);
    // Five answers' seeds, each for the key Bob holds the seed of: nothing to open.
    opened.mockClear();
    for (let i = 0; i < 5; i++) expect(await bob.session.handle(alice.session.myKey, clone(entry!))).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    // One that lost the seed (a link change it has not caught up with) opens and takes it, as before.
    const lost = new CommunitySession({ ...clone(bob.session.state), entry: { key: bob.session.state.entry.key, seedB64: "" } }, {
      save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {},
    });
    expect(await lost.handle(alice.session.myKey, clone(entry!))).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(lost.state.entry.seedB64).toBe(alice.session.state.entry.seedB64);
  });
});
