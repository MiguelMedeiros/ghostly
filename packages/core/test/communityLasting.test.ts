import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunityIncomingApp, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.pins, groups.catch-up

/*
 * A community's pin is one application frame, said once: a member away while more than the store keeps (256 frames)
 * went by was never handed it, and kept no pin, or the one the admin had taken off, for good (agents#1095). The newest
 * frame of each kind the host calls lasting is kept past the store and handed with a catch-up to whoever lacks it.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member { name: string; session: CommunitySession; online: boolean; apps: Record<string, unknown>[] }

/** The engine's rule (community.ts): the admin's `pin` frame is lasting. */
const lasting = (session: () => CommunitySession) => (m: CommunityIncomingApp) => m.frame.t === "pin" && m.sender === session().admin ? "pin" : undefined;

class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];
  constructor(private readonly withLasting = true) {}

  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      if (!to || !to.online || !member.online || to === member) return;
      this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: () => {},
      changed: () => {},
      app: m => { member.apps.push(m.frame); },
      ...(this.withLasting && { lasting: lasting(() => member.session) }),
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, apps: [] };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(member));
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
    for (let i = 0; i < 400; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

/** Alice (admin), Bob and Carol. Bob's app is closed while Alice pins `pins` in turn, then Carol says `messages` things. */
async function away(messages: number, pins: { id: string; n: number }[], withLasting = true) {
  const net = new Net(withLasting);
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  await net.settle();
  bob.online = false;
  let t = 1_000;
  for (const pin of pins) {
    const sent = await alice.session.sendApp({ t: "pin", ...pin }, "Alice", t++);
    if ("error" in sent) throw new Error(sent.error);
    await net.settle();
  }
  for (let i = 0; i < messages; i++) {
    const sent = await carol.session.sendText(`Carol ${i}`, "Carol", t++);
    if ("error" in sent) throw new Error(sent.error);
    await net.settle();
  }
  bob.online = true;
  bob.session.catchUp(carol.session.myKey);
  await net.settle();
  return { alice, bob, carol, net };
}
const pinsOf = (m: Member) => m.apps.filter(f => f.t === "pin");

describe("a community's pin reaches a member who was away however much was said meanwhile", { timeout: 120_000 }, () => {
  it("away while the admin pinned and 10 messages went by: handed with the store, as before", async () => {
    const { bob } = await away(10, [{ id: "m1", n: 5_000 }]);
    expect(pinsOf(bob)).toEqual([{ t: "pin", id: "m1", n: 5_000 }]);
  });

  it("away while 300 went by: the pin comes all the same, from a member who was not its author", async () => {
    const { bob, carol } = await away(300, [{ id: "m1", n: 5_000 }]);
    expect(carol.session.state.store.some(f => f.s !== carol.session.myKey)).toBe(false);
    expect(pinsOf(bob)).toEqual([{ t: "pin", id: "m1", n: 5_000 }]);
  });

  it("an unpin, newest of its kind, replaces the pin kept, and is what a member back after 300 gets", async () => {
    const { bob, carol } = await away(300, [{ id: "m1", n: 5_000 }, { id: "", n: 6_000 }]);
    expect(Object.keys(carol.session.state.lasting ?? {})).toEqual(["pin"]);
    expect(pinsOf(bob)).toEqual([{ t: "pin", id: "", n: 6_000 }]);
  });

  it("a member's own pin frame is not lasting, nor is any other application frame", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const carol = await net.admit(alice, "Carol");
    await net.settle();
    await carol.session.sendApp({ t: "pin", id: "m1", n: 5_000 }, "Carol", 1_000);
    await alice.session.sendApp({ t: "pay-note", x: 1 }, "Alice", 1_001);
    await net.settle();
    expect(alice.session.state.lasting ?? {}).toEqual({});
    expect(carol.session.state.lasting ?? {}).toEqual({});
  });

  it("without the hook nothing is kept past the store: the member back after 300 has no pin (the bug)", async () => {
    const { bob } = await away(300, [{ id: "m1", n: 5_000 }], false);
    expect(pinsOf(bob)).toEqual([]);
    expect(COMMUNITY_LIMITS.store).toBe(256);
  });
});
