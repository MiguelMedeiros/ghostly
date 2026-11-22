// covers: groups.protocol.community-topology
import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { COMMUNITY_LIMITS, CommunitySession, type CommunityFrame, type CommunityState } from "../src/groupCommunity";

/** What one catch-up answer holds at most: a whole store and the lasting frames. */
const BURST = COMMUNITY_LIMITS.store + COMMUNITY_LIMITS.lasting;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members on one network, on one clock: what someone broadcasts reaches every other member, and each message a member's app took is kept. */
class Net {
  now = 1_700_000_000_000;
  readonly sessions = new Map<string, CommunitySession>();
  readonly took = new Map<string, string[]>();
  private pending: Promise<unknown>[] = [];
  private hooks(name: string) {
    const deliver = (to: string | undefined, frame: CommunityFrame) => {
      const me = this.sessions.get(name)!, them = to && this.sessions.get(to);
      if (!them || them === me) return;
      this.pending.push(them.handle(me.myKey, clone(frame)));
    };
    const byKey = (key: string) => [...this.sessions].find(([, s]) => s.myKey === key)?.[0];
    return {
      save: async (_: CommunityState) => {},
      broadcast: (frame: CommunityFrame) => { for (const other of this.sessions.keys()) deliver(other, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      message: (m: { text: string }) => { this.took.get(name)!.push(m.text); },
      changed: () => {},
      clock: () => this.now,
    };
  }
  add(name: string, state: CommunityState): CommunitySession {
    this.took.set(name, []);
    const session = new CommunitySession(state, this.hooks(name));
    this.sessions.set(name, session);
    return session;
  }
  async admit(by: CommunitySession, name: string): Promise<CommunitySession> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.id, host: by.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

async function community() {
  const net = new Net();
  const alice = net.add("alice", CommunitySession.create("Ghosts"));
  const bob = await net.admit(alice, "bob");
  const mallory = await net.admit(alice, "mallory");
  await net.settle();
  net.now += COMMUNITY_LIMITS.messageWindowMs;
  return { net, alice, bob, mallory };
}

// Signing and checking hundreds of frames takes seconds on an idle runner: past vitest's 5 s default on a busy one.
describe("a community member's messages, at its pace", { timeout: 60_000 }, () => {
  it("are taken as much as a catch-up holds at once, then a window at a time, the rest neither stored nor passed on", async () => {
    const { net, mallory } = await community();
    const sent = BURST + 200;
    for (let i = 0; i < sent; i++) await mallory.sendText(`m${i}`, undefined, net.now);
    await net.settle();
    expect(net.took.get("bob")).toEqual(Array.from({ length: BURST }, (_, i) => `m${i}`));
    expect(net.took.get("alice")).toHaveLength(BURST);
    // A window later, that many more: what is sent then goes once those before it are taken.
    net.now += COMMUNITY_LIMITS.messageWindowMs;
    for (let i = sent; i < sent + 100; i++) await mallory.sendText(`m${i}`, undefined, net.now);
    await net.settle();
    expect(net.took.get("bob")).toHaveLength(BURST);
  });

  it("bounds the bytes too", async () => {
    const { net, mallory } = await community();
    const big = "x".repeat(COMMUNITY_LIMITS.textBytes - 64);
    for (let i = 0; i < 120; i++) await mallory.sendText(`${i}${big}`, undefined, net.now);
    await net.settle();
    const took = net.took.get("bob")!;
    expect(took.length).toBeGreaterThan(0);
    expect(took.length * big.length).toBeLessThanOrEqual(COMMUNITY_LIMITS.storeBytes + 2 * COMMUNITY_LIMITS.lasting * COMMUNITY_LIMITS.textBytes);
    expect(took.length).toBeLessThan(120);
  });

  it("hands what was not taken again in a catch-up, in order, none lost", async () => {
    const { net, bob, mallory } = await community();
    const sent = BURST + 90;
    for (let i = 0; i < sent; i++) await mallory.sendText(`m${i}`, undefined, net.now);
    await net.settle();
    // Each catch-up after the window takes the next ones; a later one never skips one before it.
    for (let round = 0; round < 6 && net.took.get("bob")!.length < sent; round++) {
      net.now += COMMUNITY_LIMITS.messageWindowMs;
      bob.catchUp(mallory.myKey);
      await net.settle();
    }
    expect(net.took.get("bob")).toEqual(Array.from({ length: sent }, (_, i) => `m${i}`));
  });

  it("is spent only by frames their author signed", async () => {
    const { net, alice, bob } = await community();
    await alice.sendText("real 0", undefined, net.now);
    await net.settle();
    const [frame] = alice.state.store.filter(f => f.s === alice.myKey);
    // Frames under alice's key with numbers she never signed: refused at the signature, they spend nothing of hers.
    for (let n = 1; n < 200; n++) expect(await bob.handle(alice.myKey, { ...clone(frame), n: frame.n + 1000 + n })).toBe(false);
    for (let i = 1; i < BURST; i++) await alice.sendText(`real ${i}`, undefined, net.now);
    await net.settle();
    expect(net.took.get("bob")).toHaveLength(BURST);
  });
});
