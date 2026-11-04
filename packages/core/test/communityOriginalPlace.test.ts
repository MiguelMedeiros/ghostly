// covers: groups.catch-up
import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, communityCommitHash, shortHash, type CommunityFrame, type CommunityMessageFrame, type CommunityState } from "../src/groupCommunity";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members on one network: what someone broadcasts reaches every other member. */
class Net {
  readonly sessions = new Map<string, CommunitySession>();
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
      message: () => {}, changed: () => {},
    };
  }
  add(name: string, state: CommunityState): CommunitySession {
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

type Sealer = { sendPayload(body: () => Record<string, unknown>, nick: string | undefined, now: number): Promise<{ frame: CommunityMessageFrame } | { error: string }> };

describe("a community frame said again, naming where it was first said (WISP 903 § Messages and catch-up)", () => {
  it("is remembered there only when that place is a commit the member knows", async () => {
    const net = new Net();
    const alice = net.add("alice", CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice, "bob");
    await net.settle();
    const sealer = alice as unknown as Sealer;
    const send = async (o: Record<string, unknown>) => {
      const sent = await sealer.sendPayload(() => ({ x: { t: "nothing-shown" }, o }), undefined, Date.now());
      if ("error" in sent) throw new Error(sent.error);
      return bob.handle(alice.myKey, clone(sent.frame));
    };
    const places = () => Object.keys(bob.state.seen[alice.myKey] ?? {});
    const before = places().length;

    // Places naming no commit: each frame is taken (relayed as any), but adds nothing to what Bob remembers.
    for (let i = 0; i < 20; i++) expect(await send({ e: alice.epoch, h: i.toString(16).padStart(16, "0"), n: 0 })).toBe(true);
    expect(places().length).toBe(before + 1);

    // A place that is a commit Bob knows is still remembered, so the first frame, should it come, is a duplicate.
    const first = alice.state.chain[alice.state.chain.length - 2], h = shortHash(communityCommitHash(first));
    expect(bob.commitByShort(first.e, h)).toBeDefined();
    expect(await send({ e: first.e, h, n: 7 })).toBe(true);
    expect(bob.state.seen[alice.myKey]![`${first.e}:${h}`].high).toBe(7);
  });
});
