// covers: groups.protocol.community-topology
import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunityState } from "../src/groupCommunity";

const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/identity", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/identity")>();
  return { ...actual, verify: (...args: Parameters<typeof actual.verify>) => { verified.calls++; return actual.verify(...args); } };
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members on one network: what someone broadcasts reaches every other member, and each frame a member got is kept with who sent it. */
class Net {
  readonly sessions = new Map<string, CommunitySession>();
  readonly got = new Map<string, { from: string; frame: CommunityFrame }[]>();
  private pending: Promise<unknown>[] = [];
  private hooks(name: string) {
    const deliver = (to: string | undefined, frame: CommunityFrame) => {
      const me = this.sessions.get(name)!, them = to && this.sessions.get(to);
      if (!them || them === me) return;
      this.got.get(to!)!.push({ from: me.myKey, frame: clone(frame) });
      this.pending.push(them.handle(me.myKey, clone(frame)));
    };
    const byKey = (key: string) => [...this.sessions].find(([, s]) => s.myKey === key)?.[0];
    return {
      save: async (_: CommunityState) => {},
      broadcast: (frame: CommunityFrame) => { for (const other of this.sessions.keys()) deliver(other, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      message: () => {}, changed: () => {},
    };
  }
  add(name: string, state: CommunityState): CommunitySession {
    this.got.set(name, []);
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

describe("a community member given a frame or a commit it already took", () => {
  it("drops it without checking its signature again", async () => {
    const net = new Net();
    const alice = net.add("alice", CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice, "bob");
    await net.settle();
    // Carol's admission is a commit bob takes; then alice writes to the group.
    await net.admit(alice, "carol");
    await alice.sendText("hello");
    await net.settle();
    const took = net.got.get("bob")!.filter(({ frame }) => frame.t === "group-msg" || frame.t === "group-commit");
    expect(took.map(({ frame }) => frame.t).sort()).toEqual(["group-commit", "group-msg"]);

    // The same frames again, as a second hub or a catch-up answer hands them on.
    verified.calls = 0;
    for (const { from, frame } of took) expect(await bob.handle(from, clone(frame))).toBe(false);
    expect(verified.calls).toBe(0);
  });
});
