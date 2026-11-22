import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { newEpochSecret, sealSecret } from "../src/groupCrypto";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * Any member commits a leave, with a fresh secret it picks and seals to the others: nobody can check the commit's tag
 * before that secret comes. A member followed it all the same, as the longer branch, so one that sealed nothing (or a
 * secret its tag does not confirm) left everyone on an epoch nobody else held, unable to send. A member now follows a
 * branch whose tip lists it only once it holds that tip's secret: until then it stays on the one it can read, and a
 * leave whose secret comes later is taken then.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Seal = "all" | "none" | "wrong";
interface Member { name: string; session: CommunitySession; online: boolean; seal: Seal; heard: string[] }

/** Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does). */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      // A member whose app seals no secret, or one its commit's tag does not confirm, for the commits it signs.
      if (frame.t === "group-secret" && me.seal !== "all") {
        if (me.seal === "none") return;
        frame = { ...frame, s: sealSecret(frame.to, newEpochSecret(), JSON.stringify(["ghostly-group/2 secret", frame.g, frame.h, frame.to])) };
      }
      if (frame.t === "group-secrets" && me.seal !== "all") return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: message => { this.members.get(name)!.heard.push(message.text); },
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, seal: "all", heard: [] };
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

/** Alice (admin), Bob, Carol, Dave, Erin. Bob leaves; Carol commits it, sealing as `seal` says. */
async function leaveCommittedBy(seal: Seal) {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  const dave = await net.admit(alice, "Dave");
  const erin = await net.admit(alice, "Erin");
  await net.settle();
  await bob.session.leave();
  await net.settle();
  bob.online = false;
  carol.seal = seal;
  expect(await carol.session.commitPendingLeaves()).toBe(1);
  await net.settle();
  return { net, alice, carol, dave, erin };
}

describe("a leave is followed once its secret is held", { timeout: 60_000 }, () => {
  for (const seal of ["none", "wrong"] as const) {
    it(`a leave whose committer seals ${seal === "none" ? "nothing" : "a secret its tag does not confirm"} leaves everyone else able to send`, async () => {
      const { net, alice, carol, dave, erin } = await leaveCommittedBy(seal);
      const before = carol.session.epoch - 1;
      for (const m of [alice, dave, erin]) {
        // Still on the branch they can read: Bob in the roster, the leave known but not followed.
        expect(m.session.canSend, m.name).toBe(true);
        expect(m.session.epoch, m.name).toBe(before);
        expect(names(net, m), m.name).toEqual(["Alice", "Bob", "Carol", "Dave", "Erin"]);
      }
      expect(carol.session.epoch).toBe(before + 1);
      // They talk among themselves meanwhile.
      expect("error" in await dave.session.sendText("still here")).toBe(false);
      await net.settle();
      expect(alice.heard).toContain("still here");
      expect(erin.heard).toContain("still here");
      // Bob's request is still held where the leave was not followed: the next hub commits it, sealed to everyone.
      expect(await dave.session.commitPendingLeaves()).toBe(1);
      await net.settle();
      for (const m of [alice, dave, erin]) {
        expect(m.session.canSend, m.name).toBe(true);
        expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave", "Erin"]);
      }
    });
  }

  it("the leave is taken once a secret that confirms it comes", async () => {
    const { net, alice, carol, dave, erin } = await leaveCommittedBy("none");
    const before = carol.session.epoch - 1;
    expect(alice.session.epoch).toBe(before);
    // Carol's app is fixed (or another member who holds it hands it on): her catch-up answers carry the leave's secret.
    carol.seal = "all";
    for (const m of [alice, dave, erin]) carol.session.handle(m.session.myKey, m.session.syncFrame());
    await net.settle();
    for (const m of [alice, carol, dave, erin]) {
      expect(m.session.epoch, m.name).toBe(before + 1);
      expect(m.session.canSend, m.name).toBe(true);
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave", "Erin"]);
    }
  });

  it("a leave sealed to everyone is followed as before", async () => {
    const { net, alice, carol, dave, erin } = await leaveCommittedBy("all");
    for (const m of [alice, carol, dave, erin]) {
      expect(m.session.canSend, m.name).toBe(true);
      expect(names(net, m), m.name).toEqual(["Alice", "Carol", "Dave", "Erin"]);
    }
  });
});
