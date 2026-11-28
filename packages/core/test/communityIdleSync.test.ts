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
  /** A copy of `state` as a hub on its own clock: `answer` is what goes back on the member's edge, `wait` ms after the last. */
  const hubOf = (state: CommunityState, from: string) => {
    let now = Date.now();
    const sent: CommunityFrame[] = [];
    const hub = new CommunitySession(clone(state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; }, clock: () => now,
    });
    const answer = async (sync: unknown, wait = 30_000) => {
      now += wait;
      sent.length = 0;
      await hub.handle(from, clone(sync));
      return [...sent];
    };
    return { hub, answer };
  };
  const syncs = (frames: CommunityFrame[]) => frames.filter(f => f.t === "group-sync");
  /** The member's answer to the hub's sync, from a copy of its state. */
  const answerOf = async (member: Member, hubKey: string, sync: CommunityFrame) => {
    const sent: CommunityFrame[] = [];
    const side = new CommunitySession(clone(member.session.state), {
      save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
      direct: (_to, frame) => { sent.push(frame); return true; },
    });
    await side.handle(hubKey, clone(sync));
    return sent;
  };
  const say = async (net: Net, member: Member, text: string, at: number) => {
    const sent = await member.session.sendText(text, "x", at);
    if ("error" in sent) throw new Error(sent.error);
    await net.settle();
  };

  it("asks back a member whose sync says it holds nothing the hub lacks only every five minutes", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    for (const [i, m] of [alice, bob, carol].entries()) await say(net, m, `${i}`, 1_000 + i);
    const { answer } = hubOf(alice.session.state, bob.session.myKey);
    const sync = bob.session.syncFrame();
    expect(syncs(await answer(sync))).toHaveLength(1);
    // Every 30 s while idle: the seed, and no sync back.
    for (let i = 0; i < 9; i++) {
      const frames = await answer(sync);
      expect(syncs(frames)).toHaveLength(0);
      expect(frames.map(f => f.t)).toEqual(["group-entry"]);
    }
    // Five minutes on: asked again, for the pending leaves no sync names.
    expect(syncs(await answer(sync))).toHaveLength(1);
  });

  it("asks a member whose sync says it holds a frame the hub lacks, and takes it", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.admit(alice);
    await net.settle();
    const { hub, answer } = hubOf(alice.session.state, bob.session.myKey);
    await answer(bob.session.syncFrame());
    await say(net, bob, "while the hub was away", 2_000);
    const asked = syncs(await answer(bob.session.syncFrame()));
    expect(asked).toHaveLength(1);
    // Bob's answer to that sync hands the hub his message.
    const back = await answerOf(bob, hub.myKey, asked[0]);
    expect(back.filter(f => f.t === "group-msg")).toHaveLength(1);
  });

  it("asks a member whose sync names a secret the hub lacks, another picture or name, or another tip", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    const sync = clone(bob.session.syncFrame());
    for (const changed of [{ ...sync, secrets: [...sync.secrets, "00".repeat(8)] }, { ...sync, mt: "newer" }, { ...sync, h: "00".repeat(32) }]) {
      const { answer } = hubOf(alice.session.state, bob.session.myKey);
      await answer(sync);
      expect(syncs(await answer(changed))).toHaveLength(1);
    }
  });

  it("asks a member that is behind, as it may hold frames above a gap its sync stops below", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    // Bob's sync from before Carol said a line.
    const sync = bob.session.syncFrame();
    await say(net, carol, "Bob missed this one", 3_000);
    const { answer } = hubOf(alice.session.state, bob.session.myKey);
    await answer(sync);
    // Asked back 30 s ago, and his sync names nothing the hub lacks; but he is handed a frame.
    const frames = await answer(sync);
    expect(frames.filter(f => f.t === "group-msg")).toHaveLength(1);
    expect(syncs(frames)).toHaveLength(1);
  });

  it("asks when it misses a frame below a sender's highest, and takes it from the member's answer", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    for (let i = 0; i < 5; i++) await say(net, carol, `carol ${i}`, 1_000 + i);
    const { hub, answer } = hubOf(alice.session.state, bob.session.myKey);
    const sync = bob.session.syncFrame();
    expect(syncs(await answer(sync))).toHaveLength(1);
    expect(syncs(await answer(sync))).toHaveLength(0);
    // The hub loses Carol's third frame (a gap), Bob still holds it.
    const carols = hub.state.store.filter(f => f.s === carol.session.myKey).sort((a, b) => a.n - b.n);
    const lost = carols[2], key = `${lost.e}:${lost.h}`;
    hub.state.store.splice(hub.state.store.indexOf(lost), 1);
    const entry = hub.state.seen[carol.session.myKey][key];
    entry.window = entry.window.filter(n => n !== lost.n);
    expect(entry.high).toBeGreaterThan(lost.n);
    const asked = syncs(await answer(sync));
    expect(asked).toHaveLength(1);
    const back = await answerOf(bob, hub.myKey, asked[0]);
    const again = back.filter(f => f.t === "group-msg" && f.s === carol.session.myKey && f.n === lost.n);
    expect(again).toHaveLength(1);
    await hub.handle(bob.session.myKey, clone(again[0]));
    expect(hub.state.seen[carol.session.myKey][key].window).toContain(lost.n);
  });

  it("asks when it does not hold the link's seed", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    const { hub, answer } = hubOf(alice.session.state, bob.session.myKey);
    const sync = bob.session.syncFrame();
    await answer(sync);
    expect(syncs(await answer(sync))).toHaveLength(0);
    hub.state.entry = { key: hub.state.entry.key, seedB64: "" };
    expect(syncs(await answer(sync))).toHaveLength(1);
  });

  it("let in after the member, does not ask back for the secrets and frames of epochs from before it, which it never reads", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    await say(net, alice, "before Carol", 1_000);
    await say(net, bob, "before Carol too", 1_001);
    const carol = await net.admit(alice);
    await net.settle();
    await say(net, carol, "hello", 1_002);
    // Carol's app is Bob's hub: his sync names the epochs before her.
    const sync = bob.session.syncFrame();
    const { answer } = hubOf(carol.session.state, bob.session.myKey);
    expect(syncs(await answer(sync))).toHaveLength(1);
    for (let i = 0; i < 4; i++) expect(syncs(await answer(sync))).toHaveLength(0);
    // A frame Bob says since, under an epoch Carol reads, is still asked for.
    await say(net, bob, "after Carol", 1_003);
    expect(syncs(await answer(bob.session.syncFrame()))).toHaveLength(1);
  });

  it("asks when it is waiting on a secret or a commit itself", async () => {
    const net = new Net();
    const alice = net.create(), bob = await net.admit(alice);
    await net.settle();
    const { hub, answer } = hubOf(alice.session.state, bob.session.myKey);
    const sync = bob.session.syncFrame();
    await answer(sync);
    expect(syncs(await answer(sync))).toHaveLength(0);
    vi.spyOn(hub, "needsCatchUp", "get").mockReturnValue(true);
    expect(syncs(await answer(sync))).toHaveLength(1);
  });
});
