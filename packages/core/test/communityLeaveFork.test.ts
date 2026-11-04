import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * A member's leave a hub committed, undone because the admin, back from a while away, signed an admin-only change
 * (rotate, remove, role, link) on the stale view before syncing: the admin's branch wins the fork and the leave goes to
 * the side. The hub dropped the request when it committed it, and the leaver's app forgot the group, so nobody said it
 * again and the member who left was back in every roster for good (agents#2285). Whoever drops such a leave with the
 * losing branch now holds its request again, and the next hub commits it on top.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean }

/** Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does). */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: () => {},
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Ghosts")); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const batch = this.pending.splice(0);
      if (!batch.length) { await sleep(0); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
}

const names = (net: Net, m: Member) => m.session.roster.map(([k]) => net.byKey(k)?.name ?? "?").sort();

/**
 * Alice (admin), Bob, Carol, Dave. Alice and Dave are offline; Bob leaves and Carol (a hub) commits it; Dave syncs it.
 * Alice, still on the view before, signs `stale` before her first sync, then everyone syncs.
 */
async function staleAdminAfterLeave(stale: (alice: Member, carol: Member, net: Net) => Promise<unknown>) {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  const dave = await net.admit(alice, "Dave");
  await net.settle();
  alice.online = false; dave.online = false;
  await bob.session.leave();
  await net.settle();
  bob.online = false;
  expect(await carol.session.commitPendingLeaves()).toBe(1);
  await net.settle();
  expect(names(net, carol)).toEqual(["Alice", "Carol", "Dave"]);
  dave.online = true; dave.session.catchUp(carol.session.myKey); await net.settle();
  expect(names(net, dave)).toEqual(["Alice", "Carol", "Dave"]);
  await stale(alice, carol, net);
  alice.online = true;
  alice.session.catchUp(carol.session.myKey); carol.session.catchUp(alice.session.myKey); dave.session.catchUp(alice.session.myKey);
  await net.settle();
  return { net, alice, carol, dave };
}

describe("a committed leave undone by a stale admin commit is said again", { timeout: 60_000 }, () => {
  for (const [kind, stale] of [
    ["rotate", (alice: Member) => alice.session.rotate()],
    ["link", (alice: Member) => alice.session.replaceLink()],
    ["role", (alice: Member, carol: Member) => alice.session.transferAdmin(carol.session.myKey)],
  ] as const) {
    it(`after the admin's stale ${kind} wins the fork, the next hub commits the leave again`, async () => {
      const { net, alice, carol, dave } = await staleAdminAfterLeave(stale);
      // The admin's branch won: Bob is back in the roster for now, and the leave's request is held again.
      expect(alice.session.status).toBe("active");
      expect(carol.session.state.pendingLeaves.map(r => net.byKey(r.s)?.name)).toEqual(["Bob"]);
      expect(dave.session.state.pendingLeaves.map(r => net.byKey(r.s)?.name)).toEqual(["Bob"]);
      // A hub commits it on top; everyone converges on the members who are really in.
      expect(await carol.session.commitPendingLeaves()).toBe(1);
      await net.settle();
      for (const m of [alice, carol, dave]) expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave"]);
      for (const m of [alice, carol, dave]) expect(await m.session.commitPendingLeaves(), m.name).toBe(0);
      expect(dave.session.state.pendingLeaves).toEqual([]);
    });
  }

  it("the admin's stale hand-over to the member who left loses the fork: the admin stays someone who is in", async () => {
    const { net, alice, carol, dave } = await staleAdminAfterLeave((alice, _carol, net) => alice.session.transferAdmin(net.members.get("Bob")!.session.myKey));
    for (const m of [alice, carol, dave]) {
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave"]);
      expect(net.byKey(m.session.admin!)?.name, m.name).toBe("Alice");
      expect(m.session.state.pendingLeaves, m.name).toEqual([]);
    }
    expect(alice.session.isAdmin).toBe(true);
    // The group goes on: the admin's next change is followed by everyone.
    await alice.session.rotate(); await net.settle();
    expect(new Set([alice, carol, dave].map(m => m.session.topHash)).size).toBe(1);
  });

  it("a member who hears the hand-over first moves to the leave's branch once it hears that", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const eve = await net.admit(alice, "Eve");
    await net.settle();
    // Alice and Eve are away together: Bob leaves and Carol commits it.
    alice.online = false; eve.online = false;
    await bob.session.leave(); await net.settle();
    bob.online = false;
    expect(await carol.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    // Alice hands the role to Bob on her stale view; Eve hears it first.
    carol.online = false; alice.online = true; eve.online = true;
    await alice.session.transferAdmin(bob.session.myKey); await net.settle();
    expect(net.byKey(eve.session.admin!)?.name).toBe("Bob");
    carol.online = true;
    for (const m of [alice, eve]) m.session.catchUp(carol.session.myKey);
    carol.session.catchUp(alice.session.myKey);
    await net.settle();
    for (const m of [alice, carol, eve]) {
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Eve"]);
      expect(net.byKey(m.session.admin!)?.name, m.name).toBe("Alice");
    }
    expect(new Set([alice, carol, eve].map(m => m.session.topHash)).size).toBe(1);
  });

  it("the stale hand-over heard after the admin's next change is not taken for a second history", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const eve = await net.admit(alice, "Eve");
    await net.settle();
    alice.online = false; eve.online = false;
    await bob.session.leave(); await net.settle();
    bob.online = false;
    expect(await carol.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    await alice.session.transferAdmin(bob.session.myKey);
    alice.online = true;
    alice.session.catchUp(carol.session.myKey); carol.session.catchUp(alice.session.myKey);
    await net.settle();
    await alice.session.rotate(); await net.settle();
    // Eve, away all along, hears the leave and the rotation first, then the hand-over.
    eve.online = true;
    eve.session.catchUp(carol.session.myKey); await net.settle();
    const role = alice.session.state.side.find(c => c.k === "role")!;
    expect(role).toBeDefined();
    await eve.session.handle(alice.session.myKey, { t: "group-commit", v: 2, g: eve.session.id, commit: clone(role) });
    await net.settle();
    for (const m of [alice, carol, eve]) {
      expect(m.session.status, m.name).toBe("active");
      expect(net.byKey(m.session.admin!)?.name, m.name).toBe("Alice");
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Eve"]);
    }
    expect(new Set([alice, carol, eve].map(m => m.session.topHash)).size).toBe(1);
  });

  it("a longer branch without the leave does not bring the hand-over back", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const dave = await net.admit(alice, "Dave");
    await net.settle();
    // Three views at once: Carol commits Bob's leave, Dave lets two people in, Alice hands the role to Bob.
    alice.online = false; dave.online = false;
    await bob.session.leave(); await net.settle();
    bob.online = false;
    expect(await carol.session.commitPendingLeaves()).toBe(1);
    carol.online = false; dave.online = true;
    for (const _ of [1, 2]) await dave.session.admit(createIdentity().pubKeyZ32);
    dave.online = false;
    await alice.session.transferAdmin(bob.session.myKey);
    for (const m of [alice, carol, dave]) m.online = true;
    for (const [x, y] of [[alice, carol], [alice, dave], [carol, dave], [carol, alice], [dave, alice], [dave, carol]] as const) x.session.catchUp(y.session.myKey);
    await net.settle();
    for (const m of [alice, carol, dave]) m.session.catchUp(carol.session.myKey);
    await net.settle();
    // Whatever order each heard them in, they agree, and the admin is Alice.
    expect(new Set([alice, carol, dave].map(m => m.session.topHash)).size).toBe(1);
    for (const m of [alice, carol, dave]) expect(net.byKey(m.session.admin!)?.name, m.name).toBe("Alice");
  });

  it("a mixed group: an app from before keeps the hand-over until it updates, then comes over", async () => {
    // Dave's app has no such rule: the branch with an admin change wins there, as before.
    const old = (m: Member) => { (m.session as unknown as { handedToLeaver: () => boolean }).handedToLeaver = () => false; };
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    const carol = await net.admit(alice, "Carol");
    const dave = await net.admit(alice, "Dave");
    old(dave);
    await net.settle();
    alice.online = false;
    await bob.session.leave(); await net.settle();
    bob.online = false;
    expect(await carol.session.commitPendingLeaves()).toBe(1);
    await net.settle();
    await alice.session.transferAdmin(bob.session.myKey);
    alice.online = true;
    for (const m of [alice, carol, dave]) m.session.catchUp(alice === m ? carol.session.myKey : alice.session.myKey);
    carol.session.catchUp(alice.session.myKey);
    await net.settle();
    for (const m of [alice, carol]) expect(net.byKey(m.session.admin!)?.name, m.name).toBe("Alice");
    // The older app follows the hand-over: Bob, gone, is its admin.
    expect(net.byKey(dave.session.admin!)?.name).toBe("Bob");
    expect(names(net, dave)).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    // The admin's next change: the older app takes it for a stale branch and stays where it is.
    await alice.session.rotate(); await net.settle();
    expect(net.byKey(dave.session.admin!)?.name).toBe("Bob");
    expect(dave.session.topHash).not.toBe(alice.session.topHash);
    // Updated (its saved state opened by an app with the rule), it comes over and catches up.
    net.members.delete("Dave");
    const updated = { name: "Dave", session: null as unknown as CommunitySession, online: true };
    net.members.set("Dave", updated);
    updated.session = new CommunitySession(clone(dave.session.state), (net as unknown as { hooks(n: string): CommunitySessionHooks }).hooks("Dave"));
    await net.settle();
    updated.session.catchUp(alice.session.myKey); await net.settle();
    expect(updated.session.status).toBe("active");
    expect(net.byKey(updated.session.admin!)?.name).toBe("Alice");
    expect(updated.session.topHash).toBe(alice.session.topHash);
  });

  it("a leave the winning branch holds too is not asked again", async () => {
    const { net, alice, carol, dave } = await staleAdminAfterLeave(async (alice, carol, net) => {
      // Alice is back first and syncs, then rotates: no fork, the leave stays.
      alice.online = true; alice.session.catchUp(carol.session.myKey); await net.settle();
      await alice.session.rotate(); await net.settle();
    });
    for (const m of [alice, carol, dave]) {
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave"]);
      expect(m.session.state.pendingLeaves, m.name).toEqual([]);
    }
  });
});
