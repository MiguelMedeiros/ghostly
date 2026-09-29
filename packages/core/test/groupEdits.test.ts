import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, groupMessageId, type GroupEdgeFrame, type GroupEditFrame, type GroupState } from "../src/groupSession";
import { CommunitySession, COMMUNITY_LIMITS, type CommunityFrame } from "../src/groupCommunity";
import { COMMUNITY_EDIT_FRAME, GROUP_EDIT_FRAME, carryMentions, communityEditFrame, meshMessageRef, parseCommunityEdit, type GroupIncomingEdit } from "../src/groupEdits";
// covers: groups.protocol.edits

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members of a private group, each pair on an edge that delivers at once (`setEdge` closes one). */
class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly edits = new Map<string, GroupIncomingEdit[]>();
  readonly sent: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  private closed = new Set<string>();
  private pending: Promise<unknown>[] = [];
  /** An app from before edits: its session has no `edit` hook. */
  add(state: GroupState, old = false): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame) => {
        this.sent.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (target && !this.closed.has([session.myKey, to].sort().join("|"))) this.pending.push(target.handle(session.myKey, clone(frame)));
      },
      message: () => {},
      ...(old ? {} : { edit: (e: GroupIncomingEdit) => { this.edits.get(session.myKey)!.push(e); } }),
      changed: () => {},
    });
    this.sessions.set(session.myKey, session);
    this.edits.set(session.myKey, []);
    return session;
  }
  setEdge(a: GroupSession, b: GroupSession, open: boolean): void {
    const key = [a.myKey, b.myKey].sort().join("|");
    if (open) this.closed.delete(key); else this.closed.add(key);
  }
  async settle(): Promise<void> { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
  of(s: GroupSession): GroupIncomingEdit[] { return this.edits.get(s.myKey)!; }
}

async function admit(mesh: Mesh, admin: GroupSession, old = false): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const invite = admin.inviteFrame();
  const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state, old);
  await mesh.settle();
  return session;
}

async function trio(mesh = new Mesh()) {
  const alice = mesh.add(GroupSession.create("Crew"));
  const bob = await admit(mesh, alice), carol = await admit(mesh, alice);
  await mesh.settle();
  return { mesh, alice, bob, carol };
}

describe("group-edit frames (a private group)", () => {
  it("goes from the author to every member, who read the new text as the author's edit of that message", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const sent = await bob.sendText("Working: 0 of 3");
    const id = (sent as { id: string }).id;
    expect(await bob.sendEdit(id, { v: 1, ts: 1000, text: "Working: 1 of 3" })).toEqual({ sent: 2 });
    await mesh.settle();
    for (const s of [alice, carol]) expect(mesh.of(s)).toEqual([{ id, sender: bob.myKey, e: 1, ts: 1000, m: "Working: 1 of 3" }]);
    expect(mesh.of(bob)).toEqual([]);
    // The text is sealed, the frame signed; the id is not repeated, the message's place is.
    const frame = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME)!.frame as GroupEditFrame;
    expect(JSON.stringify(frame)).not.toContain("Working");
    expect(meshMessageRef(id)).toEqual({ s: frame.s, e: frame.e, n: frame.n });
  });

  it("only its author edits a message: a member can hand the author's edit on, never alter or forge one", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("mine")) as { id: string }).id;
    expect(await carol.sendEdit(id, { v: 1, ts: 1, text: "not yours" })).toEqual({ error: "Only your own messages can be edited" });
    expect(await carol.sendEdit("garbage", { v: 1, ts: 1, text: "x" })).toHaveProperty("error");
    await bob.sendEdit(id, { v: 1, ts: 1, text: "fixed" });
    await mesh.settle();
    const frame = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME && f.to === carol.myKey)!.frame as GroupEditFrame;
    // Handed on by Carol, a member: Bob's own edit, taken again (the engine shows it once).
    await alice.handle(carol.myKey, clone(frame));
    expect(mesh.of(alice).map(e => [e.sender, e.e, e.m])).toEqual([[bob.myKey, 1, "fixed"], [bob.myKey, 1, "fixed"]]);
    // Altered on the way (a higher number, another text box): the author's signature no longer holds.
    await alice.handle(carol.myKey, { ...clone(frame), v: 2 });
    await alice.handle(carol.myKey, { ...clone(frame), c: clone(frame).c.slice(0, -4) + "AAAA" });
    // From someone not in the group: nothing.
    await alice.handle(createIdentity().pubKeyZ32, clone(frame));
    expect(mesh.of(alice)).toHaveLength(2);
  });

  it("a member hands an edit on to one whose edge to the author is down, when its sync asks for the author", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("Deploy: 0 of 2")) as { id: string }).id;
    await mesh.settle();
    // Carol's edge to Bob goes down; Bob edits twice.
    mesh.setEdge(bob, carol, false);
    await bob.sendEdit(id, { v: 1, ts: 1, text: "Deploy: 1 of 2" });
    await bob.sendEdit(id, { v: 2, ts: 2, text: "Deploy: done" });
    await mesh.settle();
    expect(mesh.of(carol)).toEqual([]);
    expect(mesh.of(alice).map(e => e.e)).toEqual([1, 2]);
    // Carol asks Alice for Bob (the catch-up of revision 0.9): Alice hands on the latest edit she kept, signed by Bob.
    await alice.handle(carol.myKey, clone(carol.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.of(carol)).toEqual([{ id, sender: bob.myKey, e: 2, ts: 2, m: "Deploy: done" }]);
    expect(mesh.sent.filter(f => f.frame.t === GROUP_EDIT_FRAME && f.from === alice.myKey && f.to === carol.myKey)).toHaveLength(1);
    // Nothing of Bob's is handed on once he is out of the group, and nothing handed on is taken.
    await alice.remove(bob.myKey);
    await mesh.settle();
    const before = mesh.sent.length;
    await alice.handle(carol.myKey, clone(carol.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.sent.slice(before).some(f => f.frame.t === GROUP_EDIT_FRAME)).toBe(false);
    const kept = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME && f.from === alice.myKey)!.frame;
    await carol.handle(alice.myKey, clone(kept));
    expect(mesh.of(carol)).toHaveLength(1);
  });

  it("a removed member's edits are dropped, even of what it sent while a member", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("before")) as { id: string }).id;
    await mesh.settle();
    const snapshot = clone(bob.state);
    await alice.remove(bob.myKey);
    await mesh.settle();
    expect(bob.status).toBe("removed");
    // Bob, from what it kept, still seals and signs for the epoch it was in.
    const handled: Promise<unknown>[] = [];
    const ghost = new GroupSession(snapshot, { save: async () => {}, send: (to, frame) => { handled.push(mesh.sessions.get(to)!.handle(bob.myKey, clone(frame))); }, message: () => {}, changed: () => {} });
    expect(await ghost.sendEdit(id, { v: 1, ts: 1, text: "rewritten after I left" })).toEqual({ sent: 2 });
    await Promise.all(handled);
    expect(mesh.of(alice)).toEqual([]);
    expect(mesh.of(carol)).toEqual([]);
  });

  it("someone admitted after the message is not sent its edits, and could not open them", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("old news")) as { id: string }).id;
    await mesh.settle();
    const dave = await admit(mesh, alice);
    expect(await bob.sendEdit(id, { v: 1, ts: 1, text: "old news, edited" })).toEqual({ sent: 2 });
    await mesh.settle();
    expect(mesh.sent.some(f => f.frame.t === GROUP_EDIT_FRAME && f.to === dave.myKey)).toBe(false);
    // Handed to Dave anyway (as a resend to one member would): it names an epoch Dave was not in.
    const frame = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME)!.frame;
    await dave.handle(bob.myKey, clone(frame));
    expect(mesh.of(dave)).toEqual([]);
    expect(mesh.of(alice)).toHaveLength(1);
    expect(mesh.of(carol)).toHaveLength(1);
  });

  it("to one member only, when asked (an edge that just opened)", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("s")) as { id: string }).id;
    expect(await bob.sendEdit(id, { v: 3, ts: 3, text: "s3" }, carol.myKey)).toEqual({ sent: 1 });
    await mesh.settle();
    expect(mesh.of(carol)).toHaveLength(1);
    expect(mesh.of(alice)).toEqual([]);
  });

  it("keeps the mentions the new text makes, and the admin's everyone only for the admin", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await alice.sendText("hey")) as { id: string }).id;
    await alice.sendEdit(id, { v: 1, ts: 1, text: "hey @all @Bob", mentions: [{ k: "*", o: 4, l: 4 }, { k: bob.myKey, o: 9, l: 4 }] });
    const bobsId = ((await bob.sendText("x")) as { id: string }).id;
    await bob.sendEdit(bobsId, { v: 1, ts: 1, text: "@all x", mentions: [{ k: "*", o: 0, l: 4 }] });
    await mesh.settle();
    expect(mesh.of(carol).find(e => e.id === id)!.k).toEqual([{ k: "*", o: 4, l: 4 }, { k: bob.myKey, o: 9, l: 4 }]);
    expect(mesh.of(carol).find(e => e.id === bobsId)).not.toHaveProperty("k");
  });

  it("an app from before edits ignores the frame and keeps working", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Crew"));
    const old = await admit(mesh, alice, true);
    const id = ((await alice.sendText("v1")) as { id: string }).id;
    await alice.sendEdit(id, { v: 1, ts: 1, text: "v2" });
    await mesh.settle();
    expect(mesh.of(old)).toEqual([]);
    expect(await old.sendText("still fine")).toHaveProperty("id");
    // A session that does not know the frame drops it (as an app from before does).
    expect(old.status).toBe("active");
  });

  it("an edit for an epoch not here yet waits for it", async () => {
    const { mesh, alice, bob, carol } = await trio();
    // Carol is cut off while Alice rotates: she stays an epoch behind.
    mesh.setEdge(alice, carol, false); mesh.setEdge(bob, carol, false);
    await alice.rotate();
    await mesh.settle();
    expect(carol.epoch).toBe(bob.epoch - 1);
    const id = ((await bob.sendText("new epoch")) as { id: string }).id;
    await bob.sendEdit(id, { v: 1, ts: 1, text: "new epoch, edited" });
    await mesh.settle();
    // The edit reaches her before the commit does.
    const frame = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME && f.to === carol.myKey)!.frame;
    await carol.handle(bob.myKey, clone(frame));
    expect(mesh.of(carol)).toEqual([]);
    mesh.setEdge(alice, carol, true); mesh.setEdge(bob, carol, true);
    await carol.handle(alice.myKey, clone(alice.syncFrame()));
    await alice.handle(carol.myKey, clone(carol.syncFrame()));
    await mesh.settle();
    expect(carol.epoch).toBe(bob.epoch);
    expect(mesh.of(carol)).toEqual([{ id, sender: bob.myKey, e: 1, ts: 1, m: "new epoch, edited" }]);
    expect(id).toBe(groupMessageId(bob.myKey, bob.epoch, 0));
  });
});

describe("community edit frames", () => {
  const author = createIdentity().pubKeyZ32, other = createIdentity().pubKeyZ32;
  const id = `${author}:4:0123456789abcdef:7`;

  it("say the author's edit of its own message; anything else is nothing", () => {
    const frame = communityEditFrame({ id, e: 2, ts: 5, m: "new", k: [{ k: other, o: 0, l: 3 }] });
    expect(frame).toEqual({ t: COMMUNITY_EDIT_FRAME, id, v: 2, ts: 5, text: "new", m: [{ k: other, o: 0, l: 3 }] });
    // The mention does not hold in this text: left out, the edit kept.
    expect(parseCommunityEdit(frame, author)).toEqual({ id, e: 2, ts: 5, m: "new" });
    expect(parseCommunityEdit({ ...frame, text: "@me x" }, author)).toEqual({ id, e: 2, ts: 5, m: "@me x", k: [{ k: other, o: 0, l: 3 }] });
    expect(parseCommunityEdit(frame, other)).toBeNull();
    expect(parseCommunityEdit({ ...frame, v: 101 }, author)).toBeNull();
    expect(parseCommunityEdit({ ...frame, text: " padded " }, author)).toBeNull();
    expect(parseCommunityEdit({ ...frame, text: "" }, author)).toBeNull();
    expect(parseCommunityEdit({ ...frame, text: "x".repeat(16 * 1024 + 1) }, author)).toBeNull();
    expect(parseCommunityEdit({ ...frame, id: `${author}:4:7` }, author)).toBeNull();
    expect(parseCommunityEdit({ ...frame, t: "reaction" }, author)).toBeNull();
  });

  it("go through the group with a text's room, not an application frame's", async () => {
    const out: CommunityFrame[] = [];
    const state = CommunitySession.create("Crew");
    const session = new CommunitySession(state, { save: async () => {}, broadcast: f => { out.push(f); }, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} });
    const sent = await session.sendText("hello");
    const mine = (sent as { id: string }).id;
    const long = "y".repeat(COMMUNITY_LIMITS.textBytes - 10);
    expect(await session.sendApp({ t: "edit", text: long })).toEqual({ error: "Too large for the group" });
    expect(await session.sendEdit({ id: mine, v: 1, ts: 1, text: long }, "A nick of some length")).toHaveProperty("id");
    expect(out).toHaveLength(2);
    expect(await session.sendEdit({ id: `${other}:0:0123456789abcdef:0`, v: 1, ts: 1, text: "no" })).toEqual({ error: "Only your own messages can be edited" });
    expect(await session.sendEdit({ id: mine, v: 1, ts: 1, text: " " })).toEqual({ error: "An edit cannot be empty" });
    expect(await session.sendEdit({ id: mine, v: 1, ts: 1, text: "\u0001".repeat(COMMUNITY_LIMITS.textBytes) })).toEqual({ error: "Too long to edit in this group" });
  });
});

describe("mentions carried into an edited text", () => {
  const bob = createIdentity().pubKeyZ32, carol = createIdentity().pubKeyZ32;
  const before = { text: "hi @Bob and @Carol", mentions: [{ k: bob, o: 3, l: 4 }, { k: carol, o: 12, l: 6 }] };

  it("stay where their words still are, in any order", () => {
    expect(carryMentions(before, "@Carol then @Bob", [], false)).toEqual([{ k: carol, o: 0, l: 6 }, { k: bob, o: 12, l: 4 }]);
    expect(carryMentions({ text: "@Bob @Bob", mentions: [{ k: bob, o: 0, l: 4 }, { k: carol, o: 5, l: 4 }] }, "x @Bob y @Bob", [], false))
      .toEqual([{ k: bob, o: 2, l: 4 }, { k: carol, o: 9, l: 4 }]);
    expect(carryMentions(before, "well, hi @Bob and @Carol!", [], false)).toEqual([{ k: bob, o: 9, l: 4 }, { k: carol, o: 18, l: 6 }]);
    expect(carryMentions(before, "nobody", [], false)).toEqual([]);
  });

  it("take those added while editing, which win where they overlap", () => {
    const dave = createIdentity().pubKeyZ32;
    expect(carryMentions(before, "hi @Bob and @Dave", [{ k: dave, o: 12, l: 5 }], false)).toEqual([{ k: bob, o: 3, l: 4 }, { k: dave, o: 12, l: 5 }]);
    expect(carryMentions(before, "hi @Bob", [{ k: dave, o: 3, l: 4 }], false)).toEqual([{ k: dave, o: 3, l: 4 }]);
    expect(carryMentions({ text: "@all go", mentions: [{ k: "*", o: 0, l: 4 }] }, "@all go now", [], false)).toEqual([]);
    expect(carryMentions({ text: "@all go", mentions: [{ k: "*", o: 0, l: 4 }] }, "@all go now", [], true)).toEqual([{ k: "*", o: 0, l: 4 }]);
  });
});
