import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { fromBase64Url } from "../src/bytes";
import { epochKeys } from "../src/groupCrypto";
import { commitHash } from "../src/groupCommits";
import { GroupSession, type GroupEdgeFrame, type GroupState } from "../src/groupSession";
import { CommunitySession, communityCommitHash, type CommunityFrame, type CommunityState } from "../src/groupCommunity";
import { encodeGroupMetaBody, signGroupMeta, wrapGroupMeta, type GroupMetaFrame } from "../src/groupMeta";
// covers: groups.picture.protocol, groups.picture.set, groups.picture.late-joiner

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function jpeg(side: number, fill = 0): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, side >> 8, side & 255, side >> 8, side & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, fill, 0xff, 0xd9));
}
const RED = jpeg(128, 1), BLUE = jpeg(128, 2);

// -- group-mesh/1 -----------------------------------------------------------------------------------

class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly saved = new Map<string, GroupState>();
  readonly pictures: { at: string; by: string; picture: string | undefined }[] = [];
  /** Members whose app predates metadata: `group-meta` never reaches them, and their syncs say nothing of it. */
  readonly old = new Set<string>();
  readonly sent: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  private pending: Promise<unknown>[] = [];
  add(state: GroupState): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async s => { this.saved.set(session.myKey, s); },
      send: (to, frame) => {
        this.sent.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (target && !(this.old.has(to) && frame.t === "group-meta")) this.pending.push(target.handle(session.myKey, clone(frame)));
      },
      message: () => {},
      changed: () => {},
      metaChanged: (by, picture) => { this.pictures.push({ at: session.myKey, by, picture }); },
    });
    this.sessions.set(session.myKey, session);
    return session;
  }
  async open(a: GroupSession, b: GroupSession): Promise<void> {
    const sync = (s: GroupSession) => { const f = clone(s.syncFrame()) as Partial<ReturnType<GroupSession["syncFrame"]>>; if (this.old.has(s.myKey)) delete f.mt; return f; };
    this.pending.push(b.handle(a.myKey, sync(a)), a.handle(b.myKey, sync(b)));
    await this.settle();
  }
  async settle(): Promise<void> { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
}

async function admit(mesh: Mesh, admin: GroupSession): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
  const joined = GroupSession.join({ name: admin.name, admin: admin.myKey }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state);
  await mesh.settle();
  for (const other of session.others) { const peer = mesh.sessions.get(other); if (peer) await mesh.open(session, peer); }
  return session;
}

/** A statement someone makes by hand, sealed under the current epoch of `session`'s group. */
function handMade(session: GroupSession, seed: Uint8Array, by: string, body: string, fields: { e?: number; r?: number } = {}): GroupMetaFrame {
  const e = fields.e ?? session.epoch;
  const meta = signGroupMeta({ g: session.id, e, h: commitHash(session.state.chain[e]), r: fields.r ?? 99, ts: 1 }, body, seed, by);
  return wrapGroupMeta(meta, session.epoch, epochKeys(fromBase64Url(session.state.secrets[session.epoch]), session.id, session.epoch).message);
}

describe("group picture, group-mesh/1", () => {
  it("the admin sets it, every member gets it, a late member gets it at sync, and removing it removes it everywhere", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice);
    await alice.setPicture(RED);
    await mesh.settle();
    expect(alice.picture).toBe(RED);
    expect(bob.picture).toBe(RED);
    expect(mesh.pictures).toContainEqual({ at: bob.myKey, by: alice.myKey, picture: RED });
    // The picture never crosses an edge in the clear.
    expect(JSON.stringify(mesh.sent.filter(s => s.frame.t === "group-meta"))).not.toContain(RED.slice(23));

    // Carol joins after it was set: nobody sets it again, the sync hands it over.
    const carol = await admit(mesh, alice);
    expect(carol.picture).toBe(RED);

    await alice.setPicture(BLUE);
    await mesh.settle();
    expect([bob.picture, carol.picture]).toEqual([BLUE, BLUE]);
    await alice.setPicture(null);
    await mesh.settle();
    expect([alice.picture, bob.picture, carol.picture]).toEqual([undefined, undefined, undefined]);
    expect(mesh.pictures.filter(p => p.at === carol.myKey).map(p => p.picture)).toEqual([RED, BLUE, undefined]);
    // Kept across a restart.
    await alice.setPicture(RED);
    await mesh.settle();
    expect(new GroupSession(clone(mesh.saved.get(bob.myKey)!), { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} }).picture).toBe(RED);
  });

  it("a member cannot set it, and a forged, altered, stale or unsafe statement is refused", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice), carol = await admit(mesh, alice);
    await expect(bob.setPicture(RED)).rejects.toThrow("Only the admin");
    await alice.setPicture(RED);
    await mesh.settle();
    const bobId = identityFromSeedB64(bob.state.seedB64);
    // Bob signs as himself (not the admin), and with his key under Alice's name.
    for (const frame of [handMade(carol, bobId.seed, bob.myKey, encodeGroupMetaBody({ pic: BLUE })), handMade(carol, bobId.seed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }))])
      await carol.handle(bob.myKey, clone(frame));
    expect(carol.picture).toBe(RED);
    // Alice's genuine statement, altered on the way: another body, another revision.
    const aliceSeed = identityFromSeedB64(alice.state.seedB64).seed;
    const genuine = handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }));
    await carol.handle(bob.myKey, { ...clone(genuine), r: 100 });
    const swapped = handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }));
    await carol.handle(bob.myKey, { ...clone(swapped), c: handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({})).c });
    // Signed, but not newer than what Carol holds.
    await carol.handle(bob.myKey, clone(handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }), { r: 1, e: 0 })));
    // Signed, with a picture Ghostly does not show.
    await carol.handle(bob.myKey, clone(handMade(carol, aliceSeed, alice.myKey, JSON.stringify({ pic: "https://tracker.example/a.jpg" }))));
    // From someone who is not a member at all.
    await carol.handle(createIdentity().pubKeyZ32, clone(genuine));
    expect(carol.picture).toBe(RED);
    // The genuine one, as it was signed, is taken.
    await carol.handle(bob.myKey, clone(genuine));
    expect(carol.picture).toBe(BLUE);
  });

  it("a new admin signs the picture again; the former admin's later statements are refused; a member admitted after sees it", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice), carol = await admit(mesh, alice);
    await alice.setPicture(RED);
    await mesh.settle();
    await alice.transferAdmin(bob.myKey);
    await mesh.settle();
    expect(bob.isAdmin).toBe(true);
    expect(bob.state.meta!.by).toBe(bob.myKey);
    expect(carol.state.meta!.by).toBe(bob.myKey);
    expect(carol.picture).toBe(RED);
    // Alice, no longer the admin, signs under the commit she was admin of, with a high revision.
    const aliceSeed = identityFromSeedB64(alice.state.seedB64).seed;
    await carol.handle(alice.myKey, clone(handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }), { e: carol.epoch - 1, r: 1000 })));
    await carol.handle(alice.myKey, clone(handMade(carol, aliceSeed, alice.myKey, encodeGroupMetaBody({ pic: BLUE }), { r: 1000 })));
    expect(carol.picture).toBe(RED);
    await expect(alice.setPicture(BLUE)).rejects.toThrow("Only the admin");
    // Dave, admitted by Bob, accepts it: Bob is the admin now and signed it.
    const dave = await admit(mesh, bob);
    expect(dave.picture).toBe(RED);
  });

  it("a statement ahead of the chain waits for it; an app without metadata is sent nothing and changes nothing", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice);
    const bobBefore = clone(bob.state);
    await alice.admit(createIdentity().pubKeyZ32);
    await alice.setPicture(RED);
    await mesh.settle();
    // Bob, as he was, gets the picture before the commit that admits Carol.
    const meta = mesh.sent.filter(s => s.frame.t === "group-meta" && s.to === bob.myKey).pop()!.frame;
    const commit = mesh.sent.find(s => s.frame.t === "group-commit" && s.to === bob.myKey && (s.frame as { commit: { e: number } }).commit.e === 2)!.frame;
    const fresh = new Mesh();
    const bob2 = fresh.add(bobBefore);
    await bob2.handle(alice.myKey, clone(meta));
    expect(bob2.picture).toBeUndefined();
    await bob2.handle(alice.myKey, clone(commit));
    expect(bob2.picture).toBe(RED);

    // An old app: its sync carries no tag, so nothing is sent to it.
    const old = new Mesh();
    const a = old.add(clone(alice.state)), b = old.add(clone({ ...bob.state, meta: undefined }));
    old.old.add(b.myKey);
    const before = old.sent.length;
    await old.open(a, b);
    expect(old.sent.slice(before).some(s => s.frame.t === "group-meta")).toBe(false);
  });
});

// -- group-community/1 ------------------------------------------------------------------------------

interface Member { name: string; session: CommunitySession; saved: CommunityState }

class Net {
  readonly members = new Map<string, Member>();
  readonly pictures: { at: string; picture: string | undefined }[] = [];
  readonly relayed: CommunityFrame[] = [];
  private pending: Promise<unknown>[] = [];
  private hooks(name: string) {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async (state: CommunityState) => { this.members.get(name)!.saved = state; },
      broadcast: (frame: CommunityFrame) => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      message: () => {},
      changed: () => {},
      metaChanged: (_by: string, picture: string | undefined) => { this.pictures.push({ at: name, picture }); },
      relay: (frame: CommunityFrame) => { this.relayed.push(frame); },
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  create(name: string): Member {
    const state = CommunitySession.create("Ghosts");
    const member: Member = { name, session: null as unknown as CommunitySession, saved: state };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  /** `by` admits a newcomer; the newcomer is not reachable until it meets someone. */
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    const member: Member = { name, session: null as unknown as CommunitySession, saved: joined.state };
    this.members.set(name, member);
    member.session = new CommunitySession(joined.state, this.hooks(name));
    return member;
  }
  async meet(a: Member, b: Member): Promise<void> {
    this.pending.push(b.session.handle(a.session.myKey, clone(a.session.syncFrame())), a.session.handle(b.session.myKey, clone(b.session.syncFrame())));
    await this.settle();
  }
  async settle(): Promise<void> { for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); } }
}

describe("group picture, group-community/1", () => {
  it("the admin sets it for everyone; someone let in by another member while the admin is away gets it from that member", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    await net.meet(alice, bob);
    await alice.session.setPicture(RED);
    await net.settle();
    expect(bob.session.picture).toBe(RED);
    await expect(bob.session.setPicture(BLUE)).rejects.toThrow("Only the admin");
    // Alice goes away; Bob lets Carol in; Carol meets Bob only.
    net.members.delete("alice");
    const carol = await net.admit(bob, "carol");
    await net.meet(bob, carol);
    expect(carol.session.picture).toBe(RED);
    expect(net.pictures).toContainEqual({ at: "carol", picture: RED });
    // Alice is back, changes it, then removes it.
    net.members.set("alice", alice);
    await net.meet(alice, carol);
    await alice.session.setPicture(BLUE);
    await net.settle();
    expect([bob.session.picture, carol.session.picture]).toEqual([BLUE, BLUE]);
    await alice.session.setPicture(null);
    await net.settle();
    expect([alice.session.picture, bob.session.picture, carol.session.picture]).toEqual([undefined, undefined, undefined]);
    expect(new CommunitySession(clone(bob.saved), { save: async () => {}, broadcast: () => {}, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} }).picture).toBeUndefined();
  });

  it("a member's statement, or a forged one, is refused and not relayed; a new admin signs it again", async () => {
    const net = new Net();
    const alice = net.create("alice");
    const bob = await net.admit(alice, "bob");
    const carol = await net.admit(alice, "carol");
    await net.meet(alice, bob); await net.meet(alice, carol); await net.meet(bob, carol);
    await alice.session.setPicture(RED);
    await net.settle();
    const s = carol.session, key = epochKeys(fromBase64Url(s.state.secrets[s.topHash]), s.id, s.epoch).message;
    const bobId = identityFromSeedB64(bob.session.state.seedB64);
    const statement = (seed: Uint8Array, by: string, r = 50) => wrapGroupMeta(signGroupMeta({ g: s.id, e: s.epoch, h: s.topHash, r, ts: 1 }, encodeGroupMetaBody({ pic: BLUE }), seed, by), s.topHash, key, true);
    const relayedBefore = net.relayed.length;
    expect(await s.handle(bob.session.myKey, clone(statement(bobId.seed, bob.session.myKey)))).toBe(false);
    expect(await s.handle(bob.session.myKey, clone(statement(bobId.seed, alice.session.myKey)))).toBe(false);
    expect(s.picture).toBe(RED);
    expect(net.relayed.length).toBe(relayedBefore);
    // A genuine one is new: the session says so, and a hub would relay it.
    const aliceSeed = identityFromSeedB64(alice.session.state.seedB64).seed;
    expect(await s.handle(bob.session.myKey, clone(statement(aliceSeed, alice.session.myKey)))).toBe(true);
    expect(s.picture).toBe(BLUE);

    await alice.session.transferAdmin(bob.session.myKey);
    await net.settle();
    expect(bob.session.isAdmin).toBe(true);
    expect(carol.session.state.meta!.by).toBe(bob.session.myKey);
    expect(carol.session.picture).toBe(RED);
    // Alice, no longer the admin, is refused even under a commit she was the admin of.
    const now = epochKeys(fromBase64Url(s.state.secrets[s.topHash]), s.id, s.epoch).message, before = s.state.chain[s.epoch - 1];
    const stale = signGroupMeta({ g: s.id, e: before.e, h: communityCommitHash(before), r: 999, ts: 1 }, "{}", aliceSeed, alice.session.myKey);
    expect(await s.handle(alice.session.myKey, clone(wrapGroupMeta(stale, s.topHash, now, true)))).toBe(false);
    expect(s.picture).toBe(RED);
  });
});
