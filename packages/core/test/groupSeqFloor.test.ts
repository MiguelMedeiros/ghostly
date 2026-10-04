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

describe("admin work off on this device (WISP 06 § Forced takeover)", () => {
  it("a mesh admin with admin work off commits nothing on a member's leave, and refuses a commit until it is on again", async () => {
    const pending: Promise<unknown>[] = [];
    const sessions: GroupSession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    let manage = true;
    const make = (state: GroupState, adminWork?: () => boolean): GroupSession => {
      const session: GroupSession = new GroupSession(clone(state), {
        save: async () => {},
        send: (to: string, frame: GroupEdgeFrame) => { for (const t of sessions) if (t.myKey === to && t !== session) pending.push(t.handle(session.myKey, clone(frame))); },
        message: () => {},
        changed: () => {},
        ...(adminWork ? { adminWork } : {}),
      });
      sessions.push(session);
      return session;
    };
    const admin = make(GroupSession.create("Crew"), () => manage);
    const join = async () => {
      const seed = createIdentity().seedB64;
      const invite = admin.inviteFrame();
      const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
      await settle();
      const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
      if ("error" in joined) throw new Error(joined.error);
      return make(joined.state);
    };
    const bob = await join(), carol = await join();
    await settle();
    const epoch = admin.epoch;
    manage = false;
    // Bob leaves: his signed goodbye reaches the admin, who passes it on and signs no commit.
    for (const s of sessions) if (s !== bob) pending.push(s.handle(bob.myKey, clone(bob.byeFrame())));
    await settle();
    expect(admin.epoch).toBe(epoch);
    await expect(admin.remove(carol.myKey)).rejects.toThrow("Manage groups from this device");
    await expect(admin.admit(createIdentity().pubKeyZ32)).rejects.toThrow("Manage groups from this device");
    // The person turns it on: the admin works again.
    manage = true;
    await admin.remove(bob.myKey);
    await settle();
    expect(admin.epoch).toBe(epoch + 1);
  });

  it("a community member with admin work off admits nobody at the door and keeps leave requests for someone else", async () => {
    const pending: Promise<unknown>[] = [];
    let manage = false;
    const sessions: CommunitySession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const hooks = (self: () => CommunitySession, adminWork?: () => boolean) => ({
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
      message: () => {},
      changed: () => {},
      ...(adminWork ? { adminWork } : {}),
    });
    let admin: CommunitySession = null as unknown as CommunitySession;
    admin = new CommunitySession(CommunitySession.create("Ghosts"), hooks(() => admin));
    sessions.push(admin);
    const joinAs = async (by: CommunitySession, adminWork?: () => boolean) => {
      const seed = createIdentity().seedB64;
      const frames = await by.admit(identityFromSeedB64(seed).pubKeyZ32);
      await settle();
      const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
      if ("error" in joined) throw new Error(joined.error);
      let s: CommunitySession = null as unknown as CommunitySession;
      s = new CommunitySession(joined.state, hooks(() => s, adminWork));
      sessions.push(s);
      return s;
    };
    const copy = await joinAs(admin, () => manage);
    const leaver = await joinAs(admin);
    await settle();
    expect(copy.adminWork).toBe(false);
    await expect(copy.admit(createIdentity().pubKeyZ32)).rejects.toThrow("Manage groups from this device");
    // The leaver's request reaches everyone; the copy commits nothing and keeps it.
    const epoch = copy.epoch;
    sessions.splice(sessions.indexOf(admin), 1);
    await leaver.leave(); await settle();
    expect(await copy.commitPendingLeaves()).toBe(0);
    expect(copy.state.pendingLeaves.map((r) => r.s)).toEqual([leaver.myKey]);
    expect(copy.epoch).toBe(epoch);
    manage = true;
    expect(await copy.commitPendingLeaves()).toBe(1);
  });
});

describe("a frame of my own key that another copy of the profile sent", () => {
  it("is not shown, and my counter goes above it, so two copies live at once in a mesh are both heard", async () => {
    const pending: Promise<unknown>[] = [];
    const received: GroupIncomingMessage[] = [];
    const ownSeen: GroupIncomingMessage[] = [];
    const sessions: GroupSession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const make = (state: GroupState, onMessage?: (m: GroupIncomingMessage) => void): GroupSession => {
      const session: GroupSession = new GroupSession(clone(state), {
        save: async () => {},
        // To every session with that key: another copy of the same profile hears it too.
        send: (to: string, frame: GroupEdgeFrame) => { for (const t of sessions) if (t.myKey === to && t !== session) pending.push(t.handle(session.myKey, clone(frame))); },
        message: (m: GroupIncomingMessage) => { onMessage?.(m); },
        changed: () => {},
      });
      sessions.push(session);
      return session;
    };
    const admin = make(GroupSession.create("Crew"), (m) => received.push(m));
    const seed = createIdentity().seedB64;
    const invite = admin.inviteFrame();
    const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    await settle();
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const a = make(joined.state, (m) => ownSeen.push(m)), b = make(joined.state, (m) => ownSeen.push(m));
    for (const text of ["a1", "a2"]) { const r = await a.sendText(text); if ("error" in r) throw new Error(r.error); }
    await settle();
    // A's frames reach B as a member passes on what another missed (a sync): B is a copy, and was never told.
    for (const f of a.state.sent) pending.push(b.handle(admin.myKey, clone(f)));
    await settle();
    const r = await b.sendText("b1"); if ("error" in r) throw new Error(r.error);
    await settle();
    expect(received.map((m) => [m.text, m.seq])).toEqual([["a1", 0], ["a2", 1], ["b1", 2]]);
    // Each copy stores only what it sent itself: the other copy's frames are not shown.
    expect(ownSeen.map((m) => m.text)).toEqual(["a1", "a2", "b1"]);
  });
});

describe("a frame of my own key past every floor", () => {
  it("is not adopted: the counter stays within 32 bits", async () => {
    const { OWN_FRAME_LIMIT } = await import("../src/groupCommits");
    const pending: Promise<unknown>[] = [];
    const received: CommunityIncomingMessage[] = [];
    const sessions: CommunitySession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const hooks = (self: () => CommunitySession, floor: () => number, take?: (m: CommunityIncomingMessage) => void) => ({
      save: async (_s: CommunityState) => {},
      broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      message: (m: CommunityIncomingMessage) => { take?.(m); },
      changed: () => {},
      seqFloor: floor,
    });
    let admin: CommunitySession = null as unknown as CommunitySession;
    admin = new CommunitySession(CommunitySession.create("Ghosts"), hooks(() => admin, () => 0, (m) => received.push(m)));
    sessions.push(admin);
    const seed = createIdentity().seedB64;
    const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    const make = (floor: number) => { let s: CommunitySession = null as unknown as CommunitySession; s = new CommunitySession(clone(joined.state), hooks(() => s, () => floor)); sessions.push(s); return s; };
    const wild = make(OWN_FRAME_LIMIT), honest = make(0);
    const r1 = await wild.sendText("far up", "b"); if ("error" in r1) throw new Error(r1.error);
    await settle();
    const r2 = await honest.sendText("here", "b"); if ("error" in r2) throw new Error(r2.error);
    await settle();
    expect(honest.state.seq).toBe(1);
  });
});
