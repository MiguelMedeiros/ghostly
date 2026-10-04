import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupState } from "../src/groupSession";
import { CommunitySession, type CommunityFrame } from "../src/groupCommunity";
// covers: devices.turn.limited

/*
 * WISP 06 § When a device checks: a group commit and door duty need a good turn read under 60 seconds old. Two devices
 * that both think they are the active one (a takeover while the other ran, a network split) would otherwise each sign
 * a commit after the same parent, and a forked group halts. Without that read a commit the person asked for is refused
 * with a message that says why, an automatic one is not made (the leave is passed on), and leave requests wait.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const UNCONFIRMED = "Can't check which device is active, so the group was not changed.";

describe("a mesh admin", () => {
  it("commits nothing, by itself or when asked, until a fresh turn read says this device is the active one", async () => {
    const pending: Promise<unknown>[] = [];
    const sessions: GroupSession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    let confirmed = true, asked = 0;
    const make = (state: GroupState, adminTurn?: () => Promise<boolean>): GroupSession => {
      const session: GroupSession = new GroupSession(clone(state), {
        save: async () => {},
        send: (to: string, frame: GroupEdgeFrame) => { for (const t of sessions) if (t.myKey === to && t !== session) pending.push(t.handle(session.myKey, clone(frame))); },
        message: () => {},
        changed: () => {},
        ...(adminTurn ? { adminTurn } : {}),
      });
      sessions.push(session);
      return session;
    };
    const admin = make(GroupSession.create("Crew"), async () => { asked++; return confirmed; });
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
    expect(asked).toBe(2);
    const epoch = admin.epoch;
    confirmed = false;
    // Bob leaves: the admin cannot confirm its turn, so it signs no commit and passes the goodbye on as a member does.
    for (const s of sessions) if (s !== bob) pending.push(s.handle(bob.myKey, clone(bob.byeFrame())));
    await settle();
    expect(admin.epoch).toBe(epoch);
    await expect(admin.remove(carol.myKey)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.rotate()).rejects.toThrow(UNCONFIRMED);
    await expect(admin.transferAdmin(carol.myKey)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.admit(createIdentity().pubKeyZ32)).rejects.toThrow(UNCONFIRMED);
    expect(admin.epoch).toBe(epoch);
    // A good read: the admin works again.
    confirmed = true;
    await admin.remove(bob.myKey);
    await settle();
    expect(admin.epoch).toBe(epoch + 1);
    expect(carol.epoch).toBe(epoch + 1);
  });
});

describe("a community hub", () => {
  it("admits nobody, changes nothing and keeps leave requests until a fresh turn read says this device is the active one", async () => {
    const pending: Promise<unknown>[] = [];
    let confirmed = true;
    const sessions: CommunitySession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const hooks = (self: () => CommunitySession, adminTurn?: () => Promise<boolean>) => ({
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to) pending.push(t.handle(self().myKey, clone(frame))); },
      message: () => {},
      changed: () => {},
      ...(adminTurn ? { adminTurn } : {}),
    });
    let admin: CommunitySession = null as unknown as CommunitySession;
    admin = new CommunitySession(CommunitySession.create("Ghosts"), hooks(() => admin, async () => confirmed));
    sessions.push(admin);
    const joinAs = async (by: CommunitySession, adminTurn?: () => Promise<boolean>) => {
      const seed = createIdentity().seedB64;
      const frames = await by.admit(identityFromSeedB64(seed).pubKeyZ32);
      await settle();
      const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
      if ("error" in joined) throw new Error(joined.error);
      let s: CommunitySession = null as unknown as CommunitySession;
      s = new CommunitySession(joined.state, hooks(() => s, adminTurn));
      sessions.push(s);
      return s;
    };
    const hub = await joinAs(admin, async () => confirmed);
    const leaver = await joinAs(admin);
    await settle();
    confirmed = false;
    await expect(hub.admit(createIdentity().pubKeyZ32)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.replaceLink()).rejects.toThrow(UNCONFIRMED);
    await expect(admin.remove(leaver.myKey)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.rotate()).rejects.toThrow(UNCONFIRMED);
    // The leaver's request reaches the hub, which commits nothing and keeps it for the next try.
    const epoch = hub.epoch;
    sessions.splice(sessions.indexOf(admin), 1);
    await leaver.leave(); await settle();
    expect(await hub.commitPendingLeaves()).toBe(0);
    expect(hub.state.pendingLeaves.map((r) => r.s)).toEqual([leaver.myKey]);
    expect(hub.epoch).toBe(epoch);
    confirmed = true;
    expect(await hub.commitPendingLeaves()).toBe(1);
    expect(hub.epoch).toBe(epoch + 1);
  });
});
