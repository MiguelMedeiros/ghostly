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

/*
 * The hub's answer carried its own sync too, so the member would hand it what it lacked: ~5 KB at 48 members, on every
 * edge every 30 s, though the member's sync had just said it held nothing the hub lacked; and the member's answer to it
 * was its entry seed again. A community of 48 idle for an hour: the hub sent 32 MB, 30 MB of it these syncs.
 */
describe("a hub answering a member's sync", { timeout: 120_000 }, () => {
  const hubOf = async (state: CommunityState) => {
    const sent: CommunityFrame[] = [];
    const hub = new CommunitySession(clone(state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; },
    });
    return { hub, sent };
  };

  it("asks nothing back of a member whose sync says it holds nothing the hub lacks", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    for (const [i, m] of [alice, bob, carol].entries()) {
      const sent = await m.session.sendText(`${i}`, "x", 1_000 + i);
      if ("error" in sent) throw new Error(sent.error);
      await net.settle();
    }
    const { hub, sent } = await hubOf(alice.session.state);
    await hub.handle(bob.session.myKey, clone(bob.session.syncFrame()));
    expect(sent.filter(f => f.t === "group-sync")).toHaveLength(0);
    expect(sent.filter(f => f.t === "group-entry")).toHaveLength(1);
  });

  it("asks a member whose sync says it holds a frame the hub lacks, and takes it", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    const before = clone(alice.session.state);
    const said = await bob.session.sendText("while the hub was away", "x", 2_000);
    if ("error" in said) throw new Error(said.error);
    await net.settle();
    const { hub, sent } = await hubOf(before);
    await hub.handle(bob.session.myKey, clone(bob.session.syncFrame()));
    const asked = sent.filter(f => f.t === "group-sync");
    expect(asked).toHaveLength(1);
    // Bob's answer to that sync hands the hub his message.
    const answer: CommunityFrame[] = [];
    const bobSide = new CommunitySession(clone(bob.session.state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { answer.push(frame); return true; },
    });
    await bobSide.handle(hub.myKey, clone(asked[0]));
    expect(answer.filter(f => f.t === "group-msg")).toHaveLength(1);
    void carol;
  });

  it("asks a member whose sync names a secret the hub lacks, or a newer picture or name", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    const sync = clone(bob.session.syncFrame());
    for (const changed of [{ ...sync, secrets: [...sync.secrets, "00".repeat(8)] }, { ...sync, mt: "newer" }, { ...sync, h: "00".repeat(32) }]) {
      const { hub, sent } = await hubOf(alice.session.state);
      await hub.handle(bob.session.myKey, clone(changed));
      expect(sent.filter(f => f.t === "group-sync")).toHaveLength(1);
    }
  });
});
