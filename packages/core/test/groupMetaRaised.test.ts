import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupSessionHooks, type GroupState } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: devices.raised-counters

/*
 * WISP 06 § Raised counters and § Forced takeover: the group's metadata (name, picture, hubs) is signed by the admin
 * like a commit is. A device whose admin work is off, or whose turn read does not say it is the active one, signs none.
 * A copy started from older state signs its next statement at a revision above the floor, so one the device it
 * replaced signed at the same revision does not leave the members holding another value than the copy.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const OFF = "Manage groups from this device";
const UNCONFIRMED = "Can't check which device is active, so the group was not changed.";
const FLOOR = 1 << 20;
function jpeg(fill: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0, 128, 0, 128, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, fill, 0xff, 0xd9));
}
const RED = jpeg(1), BLUE = jpeg(2);
type Gate = Pick<GroupSessionHooks, "seqFloor" | "adminWork" | "adminTurn">;

describe("group metadata after a start from older state (a private group, mesh)", () => {
  function mesh() {
    const sessions = new Map<string, GroupSession>();
    const pending: Promise<unknown>[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const add = (state: GroupState, gate: Gate = {}): GroupSession => {
      const session: GroupSession = new GroupSession(clone(state), {
        save: async () => {},
        // Only the session in the map gets and sends frames: a replaced one is gone from the network.
        send: (to: string, frame: GroupEdgeFrame) => {
          if (sessions.get(session.myKey) !== session) return;
          const target = sessions.get(to);
          if (target) pending.push(target.handle(session.myKey, clone(frame)));
        },
        message: () => {},
        changed: () => {},
        ...gate,
      });
      sessions.set(session.myKey, session);
      return session;
    };
    const open = async (a: GroupSession, b: GroupSession) => {
      pending.push(b.handle(a.myKey, clone(a.syncFrame())), a.handle(b.myKey, clone(b.syncFrame())));
      await settle();
    };
    const admit = async (admin: GroupSession): Promise<GroupSession> => {
      const seed = createIdentity().seedB64;
      const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
      const joined = GroupSession.join({ name: admin.name, admin: admin.myKey }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
      if ("error" in joined) throw new Error(joined.error);
      const session = add(joined.state);
      await settle();
      for (const other of session.others) { const peer = sessions.get(other); if (peer) await open(session, peer); }
      return session;
    };
    return { add, open, admit, settle };
  }

  it("a device with admin work off, or without a good turn read, signs no picture, name or hubs", async () => {
    const { add, admit, settle } = mesh();
    let work = true, turn = true;
    const admin = add(GroupSession.create("Ghosts"), { adminWork: () => work, adminTurn: async () => turn });
    const bob = await admit(admin);
    await admin.setPicture(RED); await settle();
    const r = admin.state.meta?.r;
    work = false;
    await expect(admin.setPicture(BLUE)).rejects.toThrow(OFF);
    await expect(admin.rename("Renamed")).rejects.toThrow(OFF);
    await expect(admin.setHub(bob.myKey, "pin")).rejects.toThrow(OFF);
    work = true; turn = false;
    await expect(admin.setPicture(BLUE)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.rename("Renamed")).rejects.toThrow(UNCONFIRMED);
    await expect(admin.setHub(bob.myKey, "pin")).rejects.toThrow(UNCONFIRMED);
    await settle();
    expect(admin.state.meta?.r).toBe(r);
    expect([admin.picture, bob.picture]).toEqual([RED, RED]);
    expect(bob.name).toBe("Ghosts");
    expect(bob.hubPolicy.pin).toEqual([]);
    turn = true;
    await admin.rename("Renamed"); await settle();
    expect(bob.name).toBe("Renamed");
  });

  it("a copy from an earlier backup, its floor raised, changes picture, name and hubs and every member takes them", async () => {
    const { add, open, admit, settle } = mesh();
    const lost = add(GroupSession.create("Ghosts"));
    const bob = await admit(lost), carol = await admit(lost);
    const backup = clone(lost.state);
    // The lost device changes everything once after the backup was made, at the revision the copy would reuse.
    await lost.setPicture(RED); await lost.rename("Lost"); await lost.setHub(bob.myKey, "pin"); await settle();
    expect(bob.state.meta?.r).toBe(3);
    const copy = add(backup, { seqFloor: () => FLOOR });
    await copy.setPicture(BLUE); await copy.rename("Copy"); await copy.setHub(carol.myKey, "pin"); await settle();
    await open(copy, bob); await open(copy, carol);
    for (const s of [copy, bob, carol]) {
      expect(s.picture).toBe(BLUE);
      expect(s.name).toBe("Copy");
      expect(s.hubPolicy.pin).toEqual([carol.myKey]);
    }
    expect(bob.state.meta?.r).toBe(FLOOR + 2);
  });
});

describe("group metadata after a start from older state (a community)", () => {
  function community() {
    const sessions: CommunitySession[] = [];
    const pending: Promise<unknown>[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const hooks = (self: () => CommunitySession, gate: Gate): CommunitySessionHooks => ({
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self() && t.myKey !== self().myKey) pending.push(t.handle(self().myKey, clone(frame))); },
      direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, clone(frame))); },
      message: () => {},
      changed: () => {},
      ...gate,
    });
    const add = (state: CommunityState, gate: Gate = {}): CommunitySession => {
      let s: CommunitySession = null as unknown as CommunitySession;
      s = new CommunitySession(clone(state), hooks(() => s, gate));
      sessions.push(s);
      return s;
    };
    const drop = (s: CommunitySession) => { sessions.splice(sessions.indexOf(s), 1); };
    const admit = async (admin: CommunitySession): Promise<CommunitySession> => {
      const seed = createIdentity().seedB64;
      const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
      await settle();
      const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
      if ("error" in joined) throw new Error(joined.error);
      const s = add(joined.state);
      await settle();
      return s;
    };
    return { add, drop, admit, settle };
  }

  it("a device with admin work off, or without a good turn read, signs no picture or name", async () => {
    const { add, admit, settle } = community();
    let work = true, turn = true;
    const admin = add(CommunitySession.create("Ghosts"), { adminWork: () => work, adminTurn: async () => turn });
    const bob = await admit(admin);
    await admin.setPicture(RED); await settle();
    work = false;
    await expect(admin.setPicture(BLUE)).rejects.toThrow(OFF);
    await expect(admin.rename("Renamed")).rejects.toThrow(OFF);
    work = true; turn = false;
    await expect(admin.setPicture(BLUE)).rejects.toThrow(UNCONFIRMED);
    await expect(admin.rename("Renamed")).rejects.toThrow(UNCONFIRMED);
    await settle();
    expect([admin.picture, bob.picture]).toEqual([RED, RED]);
    expect(bob.name).toBe("Ghosts");
    turn = true;
    await admin.rename("Renamed"); await settle();
    expect(bob.name).toBe("Renamed");
  });

  it("a copy from an earlier backup, its floor raised, changes picture and name and every member takes them", async () => {
    const { add, drop, admit, settle } = community();
    const lost = add(CommunitySession.create("Ghosts"));
    const bob = await admit(lost), carol = await admit(lost);
    const backup = clone(lost.state);
    await lost.setPicture(RED); await lost.rename("Lost"); await settle();
    expect(bob.state.meta?.r).toBe(2);
    drop(lost);
    const copy = add(backup, { seqFloor: () => FLOOR });
    await copy.setPicture(BLUE); await copy.rename("Copy"); await settle();
    for (const s of [copy, bob, carol]) {
      expect(s.picture).toBe(BLUE);
      expect(s.name).toBe("Copy");
    }
    expect(bob.state.meta?.r).toBe(FLOOR + 1);
  });
});
