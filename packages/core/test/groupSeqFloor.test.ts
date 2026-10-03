import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupState } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunityState } from "../src/groupCommunity";
// covers: devices.raised-counters

/*
 * WISP 06 § Raised counters: a copy of a profile started from older state (a restored backup, a forced takeover) sends
 * its group frames above every number the copy it replaced may have used. Without the floor the other members drop
 * them as already seen; with it nothing is dropped, in the epoch the copy started in and in every later one.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("the group send counter's floor (a community)", () => {
  /** A community of an admin and one member, every frame delivered at once; the member's state can be copied. */
  async function community() {
    const pending: Promise<unknown>[] = [];
    const received: CommunityIncomingMessage[] = [];
    const sessions: CommunitySession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const deliver = (from: CommunitySession, frame: CommunityFrame) => {
      for (const to of sessions) if (to !== from && to.myKey !== from.myKey) pending.push(to.handle(from.myKey, clone(frame)));
    };
    const hooks = (self: () => CommunitySession, floor: () => number, onMessage?: (m: CommunityIncomingMessage) => void) => ({
      save: async (_state: CommunityState) => {},
      broadcast: (frame: CommunityFrame) => deliver(self(), frame),
      direct: (to: string, frame: CommunityFrame) => { const t = sessions.find((s) => s.myKey === to && s !== self()); if (t) pending.push(t.handle(self().myKey, clone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { const t = sessions.find((s) => s.myKey === to && s !== self()); if (t) pending.push(t.handle(self().myKey, clone(frame))); },
      message: (m: CommunityIncomingMessage) => { onMessage?.(m); },
      changed: () => {},
      seqFloor: floor,
    });
    let admin: CommunitySession = null as unknown as CommunitySession;
    admin = new CommunitySession(CommunitySession.create("Ghosts"), hooks(() => admin, () => 0, (m) => received.push(m)));
    sessions.push(admin);
    const add = (state: CommunityState, floor = () => 0): CommunitySession => {
      let session: CommunitySession = null as unknown as CommunitySession;
      session = new CommunitySession(clone(state), hooks(() => session, floor));
      sessions.push(session);
      return session;
    };
    const drop = (s: CommunitySession) => { sessions.splice(sessions.indexOf(s), 1); };
    const seed = createIdentity().seedB64;
    const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    return { admin, received, settle, add, drop, joined: joined.state };
  }

  const say = async (s: CommunitySession, text: string) => { const sent = await s.sendText(text, "b"); if ("error" in sent) throw new Error(sent.error); };

  it("without a floor, a copy of an older state is dropped as already seen (the bug)", async () => {
    const { received, settle, add, drop, joined } = await community();
    const backup = clone(joined);
    const first = add(backup);
    await say(first, "one"); await say(first, "two"); await settle();
    drop(first);
    const copy = add(backup);
    await say(copy, "lost"); await settle();
    expect(received.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("two copies of one backup, each with its own floor, both send and nothing is dropped", async () => {
    const { received, settle, add, drop, joined } = await community();
    const backup = clone(joined);
    const original = add(backup);
    await say(original, "before the backup was restored"); await settle();
    // The first restore of the backup, then a second one an hour later: each raises the floor above the one before.
    const first = add(backup, () => 30_000_000);
    await say(first, "first copy 1"); await say(first, "first copy 2"); await settle();
    drop(first); drop(original);
    const second = add(backup, () => 30_003_600);
    await say(second, "second copy"); await settle();
    expect(received.map((m) => m.text)).toEqual(["before the backup was restored", "first copy 1", "first copy 2", "second copy"]);
    expect(received.map((m) => m.seq)).toEqual([0, 30_000_000, 30_000_001, 30_003_600]);
  });

  it("every new head starts at the floor, not at 0, so a later epoch is safe too", async () => {
    const { admin, received, settle, add, joined } = await community();
    const copy = add(joined, () => 5_000_000);
    await say(copy, "at the old head"); await settle();
    // The admin admits someone: a new head, and the counter starts again, at the floor.
    await admin.admit(createIdentity().pubKeyZ32); await settle();
    await say(copy, "at the new head"); await settle();
    expect(received.map((m) => [m.text, m.seq])).toEqual([["at the old head", 5_000_000], ["at the new head", 5_000_000]]);
  });

  it("a floor raised under a running head counts at once; a floor below the counter changes nothing", async () => {
    const { received, settle, add, joined } = await community();
    let floor = 0;
    const member = add(joined, () => floor);
    await say(member, "a"); await say(member, "b");
    floor = 1;
    await say(member, "c");
    floor = 9_000_000;
    await say(member, "d");
    floor = -5;
    await say(member, "e");
    await settle();
    expect(received.map((m) => m.seq)).toEqual([0, 1, 2, 9_000_000, 9_000_001]);
  });
});

describe("the group send counter's floor (a private group, mesh)", () => {
  async function mesh() {
    const pending: Promise<unknown>[] = [];
    const received: GroupIncomingMessage[] = [];
    const sessions: GroupSession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const make = (state: GroupState, floor: () => number, onMessage?: (m: GroupIncomingMessage) => void): GroupSession => {
      const session: GroupSession = new GroupSession(clone(state), {
        save: async () => {},
        send: (to: string, frame: GroupEdgeFrame) => { for (const t of sessions) if (t.myKey === to && t !== session) pending.push(t.handle(session.myKey, clone(frame))); },
        message: (m: GroupIncomingMessage) => { onMessage?.(m); },
        changed: () => {},
        seqFloor: floor,
      });
      sessions.push(session);
      return session;
    };
    const admin = make(GroupSession.create("Crew"), () => 0, (m) => received.push(m));
    const seed = createIdentity().seedB64;
    const invite = admin.inviteFrame();
    const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    await settle();
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const drop = (s: GroupSession) => { sessions.splice(sessions.indexOf(s), 1); };
    return { admin, received, settle, make, drop, joined: joined.state };
  }

  const say = async (s: GroupSession, text: string) => { const sent = await s.sendText(text); if ("error" in sent) throw new Error(sent.error); };

  it("a restored copy with its floor is heard; without one it is dropped", async () => {
    const { received, settle, make, drop, joined } = await mesh();
    const backup = clone(joined);
    const original = make(backup, () => 0);
    await say(original, "one"); await say(original, "two"); await settle();
    drop(original);
    const plain = make(backup, () => 0);
    await say(plain, "dropped"); await settle();
    drop(plain);
    const raised = make(backup, () => 2_000_000);
    await say(raised, "heard"); await settle();
    expect(received.map((m) => m.text)).toEqual(["one", "two", "heard"]);
  });

  it("each epoch change starts at the floor, so a member caught up to the next epoch does not send from 0 again", async () => {
    const { admin, received, settle, make, joined } = await mesh();
    const copy = make(joined, () => 3_000_000);
    await say(copy, "epoch 1"); await settle();
    await admin.admit(createIdentity().pubKeyZ32); await settle();
    await say(copy, "epoch 2"); await settle();
    expect(received.map((m) => [m.text, m.epoch, m.seq])).toEqual([["epoch 1", 1, 3_000_000], ["epoch 2", 2, 3_000_000]]);
    // The other members count no frame as missing below a floor: the window they keep is the last few numbers only.
    expect(admin.missing(copy.myKey)).toBeLessThanOrEqual(255);
  });
});
