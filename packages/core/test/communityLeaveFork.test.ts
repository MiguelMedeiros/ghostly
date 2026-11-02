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
