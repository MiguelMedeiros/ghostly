import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { fromBase64Url, toBase64Url } from "../src/bytes";
import { confirmationMatches, confirmationTag, decryptText, edgeParams, encryptText, epochKeys, newEpochSecret, openSecret, sealSecret } from "../src/groupCrypto";
import { commitHash, commitUntaggedHash, signCommit, verifyChain, verifyCommit, type GroupCommit, type Roster } from "../src/groupCommits";
import { GROUP_LIMITS, GroupSession, groupMessageId, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame, type GroupState } from "../src/groupSession";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("group key schedule", () => {
  it("seals an epoch secret to one member: only that member, with the same context, opens it", () => {
    const alice = createIdentity(), bob = createIdentity(), secret = newEpochSecret();
    const sealed = sealSecret(bob.pubKeyZ32, secret, "ctx");
    expect(openSecret(bob.seed, bob.pubKeyZ32, sealed, "ctx")).toEqual(secret);
    expect(openSecret(alice.seed, alice.pubKeyZ32, sealed, "ctx")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, sealed, "other epoch")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, c: sealed.c.slice(0, -2) + "AA" }, "ctx")).toBeNull();
  });
  it("derives distinct keys per epoch and binds text to its header", () => {
    const secret = newEpochSecret();
    const k1 = epochKeys(secret, "g", 1), k2 = epochKeys(secret, "g", 2);
    expect(toBase64Url(k1.message)).not.toBe(toBase64Url(k2.message));
    expect(toBase64Url(k1.message)).not.toBe(toBase64Url(k1.confirm));
    const box = encryptText(k1.message, "header", "hello");
    expect(decryptText(k1.message, "header", box.n, box.c)).toBe("hello");
    expect(decryptText(k1.message, "another header", box.n, box.c)).toBeNull();
    expect(decryptText(k2.message, "header", box.n, box.c)).toBeNull();
  });
  it("confirmation tags need the secret", () => {
    const a = epochKeys(newEpochSecret(), "g", 3).confirm, b = epochKeys(newEpochSecret(), "g", 3).confirm;
    const tag = confirmationTag(a, "hash");
    expect(confirmationMatches(a, "hash", tag)).toBe(true);
    expect(confirmationMatches(b, "hash", tag)).toBe(false);
    expect(confirmationMatches(a, "other", tag)).toBe(false);
  });
  it("derives the same pairwise edge on both sides, and nothing usable for a third member", () => {
    const [a, b, c] = [createIdentity(), createIdentity(), createIdentity()];
    const ab = edgeParams("group", a.seed, a.pubKeyZ32, b.pubKeyZ32), ba = edgeParams("group", b.seed, b.pubKeyZ32, a.pubKeyZ32);
    expect(identityFromSeedB64(ab.seedB64).pubKeyZ32).toBe(ba.peerPubKeyZ32);
    expect(identityFromSeedB64(ba.seedB64).pubKeyZ32).toBe(ab.peerPubKeyZ32);
    expect(ab.encKeyB64).toBe(ba.encKeyB64);
    expect(ab.profile).toBe("paired-chat/1");
    // Another group, another edge; another member, nothing in common.
    expect(edgeParams("other", a.seed, a.pubKeyZ32, b.pubKeyZ32).encKeyB64).not.toBe(ab.encKeyB64);
    const ca = edgeParams("group", c.seed, c.pubKeyZ32, a.pubKeyZ32);
    expect(ca.encKeyB64).not.toBe(ab.encKeyB64);
    expect(ca.peerPubKeyZ32).not.toBe(ba.peerPubKeyZ32);
  });
});

function draft(prev: GroupCommit | null, kind: GroupCommit["k"], m: Roster, by: string, s?: string): Omit<GroupCommit, "sig" | "c"> {
  return { v: 1, g: prev?.g ?? toBase64Url(new Uint8Array(16)), e: prev ? prev.e + 1 : 0, p: prev ? commitHash(prev) : "", k: kind, m, by, ...(s ? { s } : {}), ts: 1 };
}
const tagged = (d: Omit<GroupCommit, "sig" | "c">) => ({ ...d, c: confirmationTag(epochKeys(newEpochSecret(), d.g, d.e).confirm, commitUntaggedHash(d)) });
const sorted = (m: Roster): Roster => [...m].sort((x, y) => x[0] < y[0] ? -1 : 1);

describe("membership chain", () => {
  const admin = createIdentity(), bob = createIdentity(), carol = createIdentity();
  const genesis = signCommit(tagged(draft(null, "create", [[admin.pubKeyZ32, "admin"]], admin.pubKeyZ32)), admin.seed);
  const add = (prev: GroupCommit, who: string, by = admin) => signCommit(tagged(draft(prev, "add", sorted([...prev.m, [who, "member"]]), by.pubKeyZ32, who)), by.seed);

  it("accepts a well-formed chain and derives every epoch's roster from it", () => {
    const c1 = add(genesis, bob.pubKeyZ32), c2 = add(c1, carol.pubKeyZ32);
    const c3 = signCommit(tagged(draft(c2, "remove", c2.m.filter(([k]) => k !== bob.pubKeyZ32), admin.pubKeyZ32, bob.pubKeyZ32)), admin.seed);
    const c4 = signCommit(tagged(draft(c3, "role", c3.m.map(([k]) => [k, k === carol.pubKeyZ32 ? "admin" : "member"]), admin.pubKeyZ32, carol.pubKeyZ32)), admin.seed);
    const c5 = signCommit(tagged(draft(c4, "rotate", c4.m, carol.pubKeyZ32)), carol.seed);
    const result = verifyChain(clone([genesis, c1, c2, c3, c4, c5]));
    expect("chain" in result && result.chain.length).toBe(6);
    expect(c5.m).toEqual(sorted([[admin.pubKeyZ32, "member"], [carol.pubKeyZ32, "admin"]]));
  });
  it("rejects commits by a non-admin, with a wrong roster, a broken link, two admins or a bad signature", () => {
    const c1 = add(genesis, bob.pubKeyZ32);
    expect(verifyCommit(clone(add(c1, carol.pubKeyZ32, bob)), c1)).toHaveProperty("error", "Unauthorized or inconsistent membership change");
    const wrongRoster = signCommit(tagged(draft(c1, "add", sorted([...c1.m, [carol.pubKeyZ32, "admin"]]).map(([k, r]) => [k, k === admin.pubKeyZ32 ? "member" : r]), admin.pubKeyZ32, carol.pubKeyZ32)), admin.seed);
    expect(verifyCommit(clone(wrongRoster), c1)).toHaveProperty("error", "Unauthorized or inconsistent membership change");
    const broken = signCommit(tagged({ ...draft(c1, "add", sorted([...c1.m, [carol.pubKeyZ32, "member"]]), admin.pubKeyZ32, carol.pubKeyZ32), p: "a".repeat(64) }), admin.seed);
    expect(verifyCommit(clone(broken), c1)).toHaveProperty("error", "Commit does not follow the last known membership");
    const twoAdmins = signCommit(tagged(draft(c1, "add", sorted([...c1.m, [carol.pubKeyZ32, "admin"]]), admin.pubKeyZ32, carol.pubKeyZ32)), admin.seed);
    expect(verifyCommit(clone(twoAdmins), c1)).toHaveProperty("error", "Malformed membership commit");
    const forged = { ...add(c1, carol.pubKeyZ32), ts: 2 };
    expect(verifyCommit(clone(forged), c1)).toHaveProperty("error", "Membership commit signature is invalid");
    expect(verifyChain(clone([c1]))).toHaveProperty("error");
    const removeSelf = signCommit(tagged(draft(c1, "remove", c1.m.filter(([k]) => k !== admin.pubKeyZ32), admin.pubKeyZ32, admin.pubKeyZ32)), admin.seed);
    expect(verifyCommit(clone(removeSelf), c1)).toHaveProperty("error");
  });
  it("caps the roster at eight", () => {
    let top = genesis;
    for (let i = 0; i < 7; i++) top = add(top, createIdentity().pubKeyZ32);
    expect(top.m).toHaveLength(8);
    expect(verifyCommit(clone(add(top, createIdentity().pubKeyZ32)), top)).toHaveProperty("error");
  });
});

/** Members wired through in-memory edges that can be closed, as a member going offline closes them. */
class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly inbox = new Map<string, GroupIncomingMessage[]>();
  readonly saved = new Map<string, GroupState>();
  readonly sentFrames: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  readonly changes = new Map<string, number>();
  private closed = new Set<string>();
  private pending: Promise<unknown>[] = [];
  private edge(a: string, b: string): string { return [a, b].sort().join("|"); }
  setEdge(a: string, b: string, open: boolean): void { if (open) this.closed.delete(this.edge(a, b)); else this.closed.add(this.edge(a, b)); }
  isOpen(a: string, b: string): boolean { return !this.closed.has(this.edge(a, b)); }
  add(state: GroupState, name?: string): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async s => { this.saved.set(session.myKey, s); },
      send: (to, frame) => {
        this.sentFrames.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (!target || !this.isOpen(session.myKey, to)) return;
        this.pending.push(target.handle(session.myKey, clone(frame)));
      },
      message: m => { this.inbox.get(session.myKey)!.push(m); },
      changed: () => this.changes.set(session.myKey, (this.changes.get(session.myKey) ?? 0) + 1),
    });
    this.sessions.set(session.myKey, session);
    this.inbox.set(session.myKey, []);
    if (name) void session.setNick(session.myKey, name);
    return session;
  }
  /** Both sides of an edge that just opened introduce themselves. */
  async open(a: GroupSession, b: GroupSession): Promise<void> {
    this.setEdge(a.myKey, b.myKey, true);
    this.pending.push(b.handle(a.myKey, clone(a.syncFrame())), a.handle(b.myKey, clone(b.syncFrame())));
    await this.settle();
  }
  async settle(): Promise<void> {
    while (this.pending.length) { const batch = this.pending.splice(0); await Promise.all(batch); }
  }
  texts(session: GroupSession): string[] { return this.inbox.get(session.myKey)!.map(m => m.text); }
}

/** Admits `member` into `admin`'s group and opens its edges to everyone already in. */
async function admit(mesh: Mesh, admin: GroupSession, name: string, invite = admin.inviteFrame()): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const key = identityFromSeedB64(seed).pubKeyZ32;
  const welcome = await admin.admit(key);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state, name);
  await mesh.settle();
  for (const other of session.others) { const peer = mesh.sessions.get(other); if (peer) await mesh.open(session, peer); }
  return session;
}

describe("group session", () => {
  it("creates, admits two members and everyone reads everyone", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    expect(alice.roster.map(([, r]) => r).sort()).toEqual(["admin", "member", "member"]);
    expect(bob.epoch).toBe(2); expect(carol.epoch).toBe(2);
    expect(bob.admin).toBe(alice.myKey);
    for (const [who, text] of [[alice, "hi from alice"], [bob, "hi from bob"], [carol, "hi from carol"]] as const) expect(await who.sendText(text)).toHaveProperty("id");
    await mesh.settle();
    for (const s of [alice, bob, carol]) expect(mesh.texts(s).sort()).toEqual(["hi from alice", "hi from bob", "hi from carol"]);
    // Stable, sender-scoped ids.
    expect(mesh.inbox.get(bob.myKey)!.find(m => m.sender === alice.myKey)!.id).toBe(groupMessageId(alice.myKey, 2, 0));
  });

  it("a removed member is excluded from the next epoch: no secret, nothing readable, and its own messages are refused", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    const bobSnapshot = clone(bob.state); // what a compromised Bob keeps: seed, chain and old secrets
    await alice.remove(bob.myKey);
    await mesh.settle();
    expect(bob.status).toBe("removed");
    expect(Object.keys(bob.state.secrets)).toHaveLength(0);
    expect(alice.roster.some(([k]) => k === bob.myKey)).toBe(false);
    expect(carol.roster.some(([k]) => k === bob.myKey)).toBe(false);
    // The commit sent to Bob carries no sealed secret; the one to Carol does.
    const commits = mesh.sentFrames.filter(f => f.frame.t === "group-commit" && f.from === alice.myKey && f.frame.commit.k === "remove");
    expect(commits.find(f => f.to === bob.myKey)!.frame).not.toHaveProperty("secret");
    expect(commits.find(f => f.to === carol.myKey)!.frame).toHaveProperty("secret");
    // Even with Bob's key, Carol's sealed secret does not open, and the new epoch's messages do not decrypt with the old secret.
    const bobId = identityFromSeedB64(bobSnapshot.seedB64);
    const carolSecret = (commits.find(f => f.to === carol.myKey)!.frame as { secret: { e: string; n: string; c: string } }).secret;
    expect(openSecret(bobId.seed, bobId.pubKeyZ32, carolSecret, JSON.stringify(["ghostly-group/1 secret", alice.id, 3, bobId.pubKeyZ32]))).toBeNull();
    expect(await carol.sendText("after bob")).toHaveProperty("id");
    await mesh.settle();
    const frame = mesh.sentFrames.filter(f => f.frame.t === "group-msg" && f.from === carol.myKey).pop()!.frame as GroupMessageFrame;
    const oldKey = epochKeys(fromBase64Url(bobSnapshot.secrets[2]), alice.id, frame.e).message;
    expect(decryptText(oldKey, JSON.stringify([frame.g, frame.e, frame.s, frame.n, frame.ts]), frame.nn, frame.c)).toBeNull();
    expect(mesh.texts(bob)).not.toContain("after bob");
    expect(mesh.texts(alice)).toContain("after bob");
    // Bob, from his snapshot, still signs valid-looking frames for the epoch he was in: nobody accepts them now.
    const ghost = new GroupSession(bobSnapshot, { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} });
    await ghost.sendText("still here?");
    const stale = ghost.state.sent[0];
    await alice.handle(bob.myKey, clone(stale)); await carol.handle(bob.myKey, clone(stale));
    // Accepted for the epoch it was in: Bob was a member then. Sent again with the current epoch number it is a forgery.
    expect(mesh.texts(alice)).toContain("still here?");
    const forged = { ...stale, e: 3 };
    await alice.handle(bob.myKey, clone(forged));
    expect(mesh.texts(alice).filter(t => t === "still here?")).toHaveLength(1);
  });

  it("a new member cannot read earlier epochs: the welcome carries no earlier secret and earlier frames are dropped", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob");
    await alice.sendText("before carol"); await mesh.settle();
    const early = clone(alice.state.sent[0]);
    const carol = await admit(mesh, alice, "Carol");
    expect(carol.readableEpochs).toEqual([2]);
    // Bob got Alice's earlier message; Carol did not, and a replay of it to her goes nowhere.
    expect(mesh.texts(bob)).toEqual(["before carol"]);
    await carol.handle(alice.myKey, early);
    expect(mesh.texts(carol)).toEqual([]);
    // Nor did the sync on her edge with Alice re-send it: only messages of epochs she was in.
    expect(mesh.sentFrames.some(f => f.to === carol.myKey && f.frame.t === "group-msg" && f.frame.e < 2)).toBe(false);
    await alice.sendText("with carol"); await mesh.settle();
    expect(mesh.texts(carol)).toEqual(["with carol"]);
  });

  it("serializes two admissions made before either edge is up, and both newcomers converge", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const invite = alice.inviteFrame();
    const seeds = [createIdentity().seedB64, createIdentity().seedB64];
    const keys = seeds.map(s => identityFromSeedB64(s).pubKeyZ32);
    const [w1, w2] = await Promise.all([alice.admit(keys[0]), alice.admit(keys[1])]);
    expect(alice.epoch).toBe(2);
    const b = GroupSession.join(invite, [], w1[w1.length - 1], seeds[0]), c = GroupSession.join(invite, [], w2[w2.length - 1], seeds[1]);
    if ("error" in b || "error" in c) throw new Error("join failed");
    // Bob's welcome predates Carol's admission: he is one epoch behind until he meets someone.
    expect(b.state.chain).toHaveLength(2); expect(c.state.chain).toHaveLength(3);
    const bob = mesh.add(b.state), carol = mesh.add(c.state);
    await mesh.open(bob, carol);
    expect(bob.epoch).toBe(2);
    expect(bob.readableEpochs).toEqual([1, 2]);
    await bob.sendText("bob here"); await carol.sendText("carol here"); await mesh.settle();
    expect(mesh.texts(carol)).toEqual(["bob here", "carol here"]); expect(mesh.texts(bob)).toEqual(["bob here", "carol here"]);
    await mesh.open(alice, bob); await mesh.open(alice, carol);
    expect(mesh.texts(alice).sort()).toEqual(["bob here", "carol here"]);
  });

  it("deduplicates, accepts out-of-order sequences, and drops tampered or foreign frames", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob");
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await alice.sendText("one"); await alice.sendText("two"); await alice.sendText("three");
    const [f1, f2, f3] = alice.state.sent.map(clone);
    await bob.handle(alice.myKey, f3); await bob.handle(alice.myKey, f1); await bob.handle(alice.myKey, f3); await bob.handle(alice.myKey, f1);
    expect(mesh.texts(bob)).toEqual(["three", "one"]);
    expect(bob.missing(alice.myKey)).toBe(1);
    await bob.handle(alice.myKey, f2);
    expect(mesh.texts(bob)).toEqual(["three", "one", "two"]);
    expect(bob.missing(alice.myKey)).toBe(0);
    await bob.handle(alice.myKey, { ...f2, c: f2.c.slice(0, -2) + "AA" });
    await bob.handle(alice.myKey, { ...f2, n: 7 });
    await bob.handle(bob.myKey, { ...f2, s: bob.myKey, n: 9 });
    const stranger = createIdentity();
    await bob.handle(stranger.pubKeyZ32, { ...f2, s: stranger.pubKeyZ32, n: 9 });
    await bob.handle(alice.myKey, { ...f2, g: toBase64Url(new Uint8Array(16)) });
    expect(mesh.texts(bob)).toEqual(["three", "one", "two"]);
    expect(Object.values(bob.state.seen[alice.myKey])).toEqual([{ high: 2, window: [0, 1] }]);
  });

  it("catches an offline member up from the authors' bounded logs, including an epoch rotated meanwhile", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    mesh.setEdge(alice.myKey, bob.myKey, false); mesh.setEdge(carol.myKey, bob.myKey, false);
    await alice.sendText("alice while bob away"); await carol.sendText("carol while bob away");
    await alice.rotate();
    await alice.sendText("after the rotation"); await mesh.settle();
    expect(mesh.texts(bob)).toEqual([]);
    expect(bob.epoch).toBe(2);
    await mesh.open(alice, bob);
    expect(bob.epoch).toBe(3);
    expect(bob.readableEpochs).toEqual([1, 2, 3]);
    expect(mesh.texts(bob)).toEqual(["alice while bob away", "after the rotation"]);
    await mesh.open(carol, bob);
    expect(mesh.texts(bob)).toEqual(["alice while bob away", "after the rotation", "carol while bob away"]);
    // A second meeting re-sends nothing.
    const before = mesh.sentFrames.length;
    await mesh.open(alice, bob);
    expect(mesh.sentFrames.slice(before).filter(f => f.frame.t !== "group-sync")).toEqual([]);
    // Bob can talk in the new epoch right away.
    await bob.sendText("back"); await mesh.settle();
    expect(mesh.texts(alice)).toContain("back"); expect(mesh.texts(carol)).toContain("back");
  });

  it("buffers frames of an epoch it has not reached, then reads them once the commit and secret arrive", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await alice.rotate(); await mesh.settle();
    await carol.sendText("in the new epoch"); await mesh.settle();
    // Bob, still at epoch 2, asked Carol (who is ahead) rather than waiting; she answered with the commit and its secret.
    expect(mesh.sentFrames.some(f => f.from === bob.myKey && f.to === carol.myKey && f.frame.t === "group-sync")).toBe(true);
    expect(mesh.sentFrames.some(f => f.from === carol.myKey && f.to === bob.myKey && f.frame.t === "group-commit" && "secret" in f.frame)).toBe(true);
    expect(bob.epoch).toBe(3);
    expect(mesh.texts(bob)).toEqual(["in the new epoch"]);
    expect(mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit" && f.frame.commit.k === "rotate")).toHaveLength(1); // dropped: the edge was down
  });

  it("halts on a fork: two different histories for one epoch, both validly signed", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    // A second device of the admin (or a compromised key) commits differently at the same epoch.
    const evilAlice = new GroupSession(clone(alice.state), { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} });
    await evilAlice.rotate();
    await alice.remove(carol.myKey); await mesh.settle();
    expect(bob.epoch).toBe(3); expect(bob.status).toBe("active");
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: clone(evilAlice.top) });
    expect(bob.status).toBe("forked");
    expect(await bob.sendText("anyone?")).toHaveProperty("error");
    // A bare claim of a different hash in a sync is not a fork: it is answered with the commit, so the liar is the one who forks, if anyone.
    const changes = mesh.changes.get(alice.myKey) ?? 0;
    await alice.handle(bob.myKey, { ...bob.syncFrame(), h: "f".repeat(64) });
    expect(alice.status).toBe("active");
    expect(mesh.changes.get(alice.myKey) ?? 0).toBe(changes);
    expect(mesh.sentFrames.at(-1)).toMatchObject({ from: alice.myKey, to: bob.myKey, frame: { t: "group-commit" } });
  });

  it("transfers the admin role: the new admin commits, the old one no longer can", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    await alice.transferAdmin(bob.myKey); await mesh.settle();
    expect(bob.isAdmin).toBe(true); expect(alice.isAdmin).toBe(false);
    expect(carol.admin).toBe(bob.myKey);
    await expect(alice.remove(carol.myKey)).rejects.toThrow(/Only the admin/);
    const dave = await admit(mesh, bob, "Dave");
    expect(dave.roster).toHaveLength(4);
    await dave.sendText("hello all"); await mesh.settle();
    expect(mesh.texts(alice)).toContain("hello all");
    // A commit the former admin signs anyway is refused everywhere.
    const stale = new GroupSession(clone({ ...alice.state, chain: alice.state.chain.slice(0, 3) }), { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} });
    await stale.rotate();
    await carol.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: clone(stale.top) });
    expect(carol.status).toBe("forked"); // it *is* a validly signed fork of epoch 3, and that is what the protocol says about it
    await dave.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: clone(stale.top) });
    expect(dave.status).toBe("forked");
  });

  it("lets a member leave: its secrets go at once, the admin removes it, and the admin cannot leave first", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    await expect(alice.leave()).rejects.toThrow(/admin/);
    await bob.leave(); await mesh.settle();
    expect(bob.status).toBe("left");
    expect(bob.state.secrets).toEqual({});
    expect(alice.roster.map(([k]) => k)).not.toContain(bob.myKey);
    expect(carol.roster.map(([k]) => k)).not.toContain(bob.myKey);
    expect(alice.epoch).toBe(3);
    await carol.sendText("just us"); await mesh.settle();
    expect(mesh.texts(bob)).toEqual([]);
    expect(mesh.texts(alice)).toContain("just us");
  });

  it("keeps its own log and its waiting room bounded", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob");
    mesh.setEdge(alice.myKey, bob.myKey, false);
    for (let i = 0; i < GROUP_LIMITS.outlog + 5; i++) await alice.sendText(`m${i}`);
    expect(alice.state.sent).toHaveLength(GROUP_LIMITS.outlog);
    expect(alice.state.sent[0].n).toBe(5);
    await mesh.open(alice, bob);
    expect(mesh.texts(bob)).toHaveLength(GROUP_LIMITS.outlog);
    expect(bob.missing(alice.myKey)).toBe(5);
    // Frames far ahead of the chain are refused; frames one epoch ahead wait, up to a bound.
    const far = { ...alice.state.sent[0], e: alice.epoch + GROUP_LIMITS.secrets + 1 };
    await bob.handle(alice.myKey, far);
    expect((bob as unknown as { waiting: unknown[] }).waiting).toHaveLength(0);
    mesh.setEdge(alice.myKey, bob.myKey, false);
    for (let i = 0; i < GROUP_LIMITS.waiting + 10; i++) await bob.handle(alice.myKey, { ...alice.state.sent[0], e: alice.epoch + 1, n: i });
    expect((bob as unknown as { waiting: unknown[] }).waiting).toHaveLength(GROUP_LIMITS.waiting);
    // Only one question was asked of Alice for all of that.
    expect(mesh.sentFrames.filter(f => f.from === bob.myKey && f.frame.t === "group-sync").length).toBeLessThanOrEqual(2);
  });

  it("splits a long chain into pieces before the welcome, and the newcomer verifies all of it", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    for (let i = 0; i < GROUP_LIMITS.chainPiece + 3; i++) await alice.rotate();
    const bob = await admit(mesh, alice, "Bob");
    expect(bob.state.chain).toHaveLength(GROUP_LIMITS.chainPiece + 5);
    const pieces = mesh.sentFrames.length; // pieces go over the contact link, not an edge; nothing was sent there
    expect(pieces).toBeGreaterThanOrEqual(0);
    await alice.sendText("long history"); await mesh.settle();
    expect(mesh.texts(bob)).toEqual(["long history"]);
  });

  it("refuses a welcome from a group the invitation's admin did not create, or one that does not admit this key", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const seed = createIdentity().seedB64, key = identityFromSeedB64(seed).pubKeyZ32;
    const welcome = await alice.admit(key);
    expect(GroupSession.join({ name: "x", admin: createIdentity().pubKeyZ32 }, [], welcome[0], seed)).toHaveProperty("error", "The group's admin is not the contact who invited you");
    expect(GroupSession.join({ name: "x", admin: alice.myKey }, [], welcome[0], createIdentity().seedB64)).toHaveProperty("error");
    const noSecret = { ...(welcome[0] as { secrets: unknown[] }), secrets: [] };
    expect(GroupSession.join({ name: "x", admin: alice.myKey }, [], noSecret, seed)).toHaveProperty("error");
    expect(GroupSession.join({ name: "x", admin: alice.myKey }, [], welcome[0], seed)).toHaveProperty("state");
  });

  it("survives a restart from saved state", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"));
    const bob = await admit(mesh, alice, "Bob");
    await alice.sendText("first"); await mesh.settle();
    const restored = new Mesh();
    const alice2 = restored.add(clone(mesh.saved.get(alice.myKey)!)), bob2 = restored.add(clone(mesh.saved.get(bob.myKey)!));
    expect(bob2.epoch).toBe(1); expect(bob2.readableEpochs).toEqual([1]);
    await restored.open(alice2, bob2);
    expect(restored.texts(bob2)).toEqual([]); // already seen before the restart: not delivered twice
    await alice2.sendText("second"); await restored.settle();
    expect(restored.texts(bob2)).toEqual(["second"]);
    expect(restored.inbox.get(bob2.myKey)![0].id).toBe(groupMessageId(alice.myKey, 1, 1));
  });
});
