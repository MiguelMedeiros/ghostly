import { describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, groupMessageId, type GroupEdgeFrame, type GroupEditFrame, type GroupState } from "../src/groupSession";
import { CommunitySession, COMMUNITY_LIMITS, type CommunityFrame } from "../src/groupCommunity";
import { COMMUNITY_EDIT_FRAME, GROUP_EDIT_FRAME, carryMentions, communityEditFrame, meshMessageRef, parseCommunityEdit, type GroupIncomingEdit } from "../src/groupEdits";
import { REMOVED_TEXT } from "../src/pairedEdits";
// covers: groups.protocol.edits

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members of a private group, each pair on an edge that delivers at once (`setEdge` closes one). */
class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly edits = new Map<string, GroupIncomingEdit[]>();
  readonly sent: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  /** What each member's session saved, in order (the whole record each time). */
  readonly saves = new Map<string, GroupState[]>();
  /** Members that pass on what their session took, as a hub does (WISP 902 § Hubs), and whom each member counts on. */
  readonly hubs = new Set<string>();
  readonly carriers = new Map<string, string[]>();
  /** The sessions' clock (`hooks.clock`) when set; the wall clock otherwise. */
  clock: number | null = null;
  /** Moves the sessions' clock on by `ms`, from the wall clock the first time: an author's frames taken at its pace. */
  tick(ms: number): void { this.clock = (this.clock ?? Date.now()) + ms; }
  private closed = new Set<string>();
  private pending: Promise<unknown>[] = [];
  /** An app from before edits: its session has no `edit` hook. */
  add(state: GroupState, old = false): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async state => { this.saves.get(session.myKey)!.push(clone(state)); },
      send: (to, frame) => this.deliver(session, to, frame),
      message: () => {},
      clock: () => this.clock ?? Date.now(),
      ...(old ? {} : { edit: (e: GroupIncomingEdit) => { this.edits.get(session.myKey)!.push(e); } }),
      changed: () => {},
      carriers: () => this.carriers.get(session.myKey) ?? [],
    });
    this.sessions.set(session.myKey, session);
    this.edits.set(session.myKey, []);
    this.saves.set(session.myKey, []);
    return session;
  }
  private deliver(from: GroupSession, to: string, frame: GroupEdgeFrame): void {
    this.sent.push({ from: from.myKey, to, frame: clone(frame) });
    const target = this.sessions.get(to);
    if (!target || this.closed.has([from.myKey, to].sort().join("|"))) return;
    this.pending.push(target.handle(from.myKey, clone(frame)).then(took => {
      if (!this.hubs.has(to)) return;
      for (const f of took) for (const key of this.sessions.keys()) {
        if (key !== from.myKey && key !== to && key !== (f as { s?: string }).s) this.deliver(target, key, target.handOnTo(key, f));
      }
    }));
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

  it("a removal goes sealed as the message's last edit, its fallback alone, and may pass a card's bound by one", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("Working: 0 of 3")) as { id: string }).id;
    const card = { kind: "task", id: "t1", title: "Fix it", status: "running" } as const;
    expect(await bob.sendEdit(id, { v: 5_001, ts: 9, text: "too far", card })).toEqual({ error: "This message was edited too many times" });
    expect(await bob.sendEdit(id, { v: 5_002, ts: 9, text: REMOVED_TEXT, remove: true })).toEqual({ error: "This message was edited too many times" });
    expect(await bob.sendEdit(id, { v: 5_001, ts: 9, text: REMOVED_TEXT, mentions: [{ k: alice.myKey, o: 0, l: 2 }], card, remove: true })).toEqual({ sent: 2 });
    await mesh.settle();
    for (const s of [alice, carol]) expect(mesh.of(s)).toEqual([{ id, sender: bob.myKey, e: 5_001, ts: 9, m: REMOVED_TEXT, rm: true }]);
    expect(JSON.stringify(mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME)!.frame)).not.toContain("Message removed");
    // Only its author removes it.
    expect(await carol.sendEdit(id, { v: 5_001, ts: 9, text: REMOVED_TEXT, remove: true })).toEqual({ error: "Only your own messages can be edited" });
  });

  it("only its author edits a message: a member can hand the author's edit on, never alter or forge one", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const id = ((await bob.sendText("mine")) as { id: string }).id;
    expect(await carol.sendEdit(id, { v: 1, ts: 1, text: "not yours" })).toEqual({ error: "Only your own messages can be edited" });
    expect(await carol.sendEdit("garbage", { v: 1, ts: 1, text: "x" })).toHaveProperty("error");
    await bob.sendEdit(id, { v: 1, ts: 1, text: "fixed" });
    await mesh.settle();
    const frame = mesh.sent.find(f => f.frame.t === GROUP_EDIT_FRAME && f.to === carol.myKey)!.frame as GroupEditFrame;
    // Handed on by Carol, a member: Bob's own edit, taken already (another hub's copy), so not again.
    await alice.handle(carol.myKey, clone(frame));
    expect(mesh.of(alice).map(e => [e.sender, e.e, e.m])).toEqual([[bob.myKey, 1, "fixed"]]);
    // Altered on the way (a higher number, another text box): the author's signature no longer holds.
    await alice.handle(carol.myKey, { ...clone(frame), v: 2 });
    await alice.handle(carol.myKey, { ...clone(frame), c: clone(frame).c.slice(0, -4) + "AAAA" });
    // From someone not in the group: nothing.
    await alice.handle(createIdentity().pubKeyZ32, clone(frame));
    expect(mesh.of(alice)).toHaveLength(1);
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

  for (const how of ["leaves", "is removed"] as const) {
    it(`a removal said while a member was away reaches it after its author ${how}; an edit does not`, async () => {
      const { mesh, alice, bob, carol } = await trio();
      const gone = ((await bob.sendText("delete me")) as { id: string }).id;
      const edited = ((await bob.sendText("edit me")) as { id: string }).id;
      await mesh.settle();
      // Carol is away; Bob deletes one for everyone, edits the other, and is out of the group.
      mesh.setEdge(carol, alice, false); mesh.setEdge(carol, bob, false);
      await bob.sendEdit(gone, { v: 1, ts: 1, text: REMOVED_TEXT, remove: true });
      await bob.sendEdit(edited, { v: 1, ts: 2, text: "edited" });
      await mesh.settle();
      expect(mesh.of(alice).map(e => e.id)).toEqual([gone, edited]);
      if (how === "leaves") await bob.leave(); else await alice.remove(bob.myKey);
      await mesh.settle();
      expect(alice.others).toEqual([carol.myKey]);
      // Carol is back and catches up from Alice: Bob is no one to ask for any more.
      mesh.setEdge(carol, alice, true);
      await alice.handle(carol.myKey, clone(carol.syncFrame([])));
      await mesh.settle();
      expect(carol.others).toEqual([alice.myKey]);
      expect(mesh.of(carol)).toEqual([{ id: gone, sender: bob.myKey, e: 1, ts: 1, m: REMOVED_TEXT, rm: true }]);
      // Once to each member: a later sync hands it no more.
      const before = mesh.sent.length;
      await alice.handle(carol.myKey, clone(carol.syncFrame([])));
      await mesh.settle();
      expect(mesh.sent.slice(before).some(f => f.frame.t === GROUP_EDIT_FRAME)).toBe(false);
    });
  }

  for (const via of ["a member", "a hub let in after it"] as const) {
    it(`one member's many edits of messages that are not there push out only its own: a removal kept for one away still reaches it (through ${via})`, async () => {
      const { mesh, alice, bob, carol } = await trio();
      const dave = await admit(mesh, alice);
      const gone = ((await carol.sendText("secret oops")) as { id: string }).id;
      await mesh.settle();
      const epoch = carol.epoch;
      // On hubs: one let in after the message, which Carol and Bob count on; it cannot open what was said before it.
      const hub = via === "a member" ? alice : await admit(mesh, alice);
      if (hub !== alice) { mesh.hubs.add(hub.myKey); for (const s of [carol, bob]) mesh.carriers.set(s.myKey, [hub.myKey]); }
      // Dave is away; Carol deletes her message for everyone, then is gone (out of the group; on hubs, offline: a hub
      // carries what it cannot open only while its author is a member).
      for (const s of [alice, bob, carol, hub]) mesh.setEdge(dave, s, false);
      expect(await carol.sendEdit(gone, { v: 1, ts: 1, text: REMOVED_TEXT, remove: true })).toHaveProperty("sent");
      await mesh.settle();
      if (hub === alice) await carol.leave(); else for (const s of [alice, bob, hub]) mesh.setEdge(carol, s, false);
      await mesh.settle();
      // Bob edits, with the longest text, as many messages of his as the log holds, none of which he ever sent.
      for (let n = 1_000; n < 1_064; n++) {
        expect(await bob.sendEdit(groupMessageId(bob.myKey, epoch, n), { v: 1, ts: 2, text: "x".repeat(16 * 1024 - 64) })).toHaveProperty("sent");
      }
      await mesh.settle();
      // Dave is back on an edge to the hub alone and catches up: Carol's removal is still there for him.
      mesh.setEdge(dave, hub, true);
      await hub.handle(dave.myKey, clone(dave.syncFrame(hub === alice ? [] : [carol.myKey])));
      await mesh.settle();
      expect(mesh.of(dave).filter(e => e.id === gone && e.rm)).toHaveLength(1);
    });
  }

  it("a burst of edits taken is saved once a window, not once each, and what one save lost comes back at catch-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { mesh, alice, bob, carol } = await trio();
      const id = ((await bob.sendText("Deploy: 0 of 2")) as { id: string }).id;
      await mesh.settle();
      for (const s of [alice, carol]) await s.flush();
      const before = clone(carol.state);
      for (const s of [alice, carol]) mesh.saves.get(s.myKey)!.length = 0;
      // Bob edits 200 messages of his that are not there, each signed and sealed: neither member saves its whole record
      // for each. At his pace, so each is taken (the clock the sessions read, not the save's timer).
      const epoch = bob.epoch;
      for (let n = 1_000; n < 1_200; n++) {
        mesh.tick(400);
        expect(await bob.sendEdit(groupMessageId(bob.myKey, epoch, n), { v: 1, ts: 2, text: "x" })).toHaveProperty("sent");
      }
      // And one honest edit of a line that is there.
      mesh.tick(400);
      await bob.sendEdit(id, { v: 1, ts: 3, text: "Deploy: done" });
      await mesh.settle();
      for (const s of [alice, carol]) expect(mesh.saves.get(s.myKey)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      for (const s of [alice, carol]) { await s.flush(); expect(mesh.saves.get(s.myKey)).toHaveLength(1); }
      // The honest edit is in what was saved: a restart keeps it to hand on.
      const saved = mesh.saves.get(carol.myKey)!.at(-1)!;
      const ref = meshMessageRef(id)!;
      expect(new GroupSession(clone(saved), { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} }).state.relayEdits)
        .toContainEqual(expect.objectContaining({ s: bob.myKey, n: ref.n, v: 1 }));
      // Carol killed before that save (her app has the edit): her session back from the record before takes the frame
      // again when she asks for Bob, and keeps it to hand on.
      const back = mesh.add(clone(before));
      mesh.setEdge(back, bob, false);
      await alice.handle(back.myKey, clone(back.syncFrame([bob.myKey])));
      await mesh.settle();
      expect(mesh.of(back)).toContainEqual({ id, sender: bob.myKey, e: 1, ts: 3, m: "Deploy: done" });
      expect(back.state.relayEdits).toContainEqual(expect.objectContaining({ s: bob.myKey, n: ref.n, v: 1 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("an author's own burst of edits is kept as before: the latest of each, as many as the log holds", async () => {
    const { mesh, alice, bob } = await trio();
    const ids: string[] = [];
    // At his pace, so each is taken.
    for (let i = 0; i < 70; i++) { mesh.tick(400); ids.push(((await bob.sendText(`line ${i}`)) as { id: string }).id); }
    for (const id of ids) { mesh.tick(400); await bob.sendEdit(id, { v: 1, ts: 1, text: "edited" }); }
    mesh.tick(400);
    await bob.sendEdit(ids[69], { v: 2, ts: 2, text: "edited again" });
    await mesh.settle();
    expect((alice.state.relayEdits ?? []).map(f => [f.n, f.v])).toEqual(ids.slice(-64).map((id, i) => [meshMessageRef(id)!.n, i === 63 ? 2 : 1]));
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

  it("on hubs, an edit and a removal of a message older than the hub reach the members through it, live and at catch-up", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const kept = ((await bob.sendText("keep A")) as { id: string }).id;
    const gone = ((await bob.sendText("del B")) as { id: string }).id;
    await mesh.settle();
    // A hub let in after both messages: Bob's only edge is to it, and Carol is away.
    const hub = await admit(mesh, alice);
    mesh.hubs.add(hub.myKey);
    mesh.carriers.set(bob.myKey, [hub.myKey]);
    mesh.setEdge(bob, alice, false); mesh.setEdge(bob, carol, false);
    mesh.setEdge(carol, alice, false); mesh.setEdge(carol, hub, false);
    expect(await bob.sendEdit(kept, { v: 1, ts: 1, text: "A edited" })).toEqual({ sent: 2 });
    expect(await bob.sendEdit(gone, { v: 5_001, ts: 2, text: REMOVED_TEXT, remove: true })).toEqual({ sent: 2 });
    await mesh.settle();
    // The hub cannot read them (it was not in their epoch), but carries them on.
    expect(mesh.of(hub)).toEqual([]);
    expect(mesh.of(alice)).toEqual([
      { id: kept, sender: bob.myKey, e: 1, ts: 1, m: "A edited" },
      { id: gone, sender: bob.myKey, e: 5_001, ts: 2, m: REMOVED_TEXT, rm: true },
    ]);
    // Carol is back on the hub alone: her catch-up asks it for Bob.
    mesh.setEdge(carol, hub, true);
    await hub.handle(carol.myKey, clone(carol.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.of(carol).map(e => [e.id, e.e])).toEqual([[kept, 1], [gone, 5_001]]);
    // Carried blind only as the author signed it, and only while the author is in the roster.
    mesh.setEdge(bob, hub, false);
    await bob.sendEdit(kept, { v: 2, ts: 3, text: "A again" });
    const late = mesh.sent.filter(f => f.frame.t === GROUP_EDIT_FRAME && f.to === hub.myKey).pop()!.frame as GroupEditFrame;
    expect(late.v).toBe(2);
    expect(await hub.handle(alice.myKey, { ...clone(late), v: 3 })).toEqual([]);
    await alice.remove(bob.myKey);
    await mesh.settle();
    expect(await hub.handle(alice.myKey, clone(late))).toEqual([]);
  });

  it("on hubs, a hub let in after an edit is handed it unread, once, by those that hold it, and carries it to a member back", async () => {
    const { mesh, alice, bob, carol } = await trio();
    const kept = ((await bob.sendText("keep A")) as { id: string }).id;
    const gone = ((await bob.sendText("del B")) as { id: string }).id;
    await mesh.settle();
    // Carol is away. Hub A, let in after both messages, is Bob's only edge when he edits them, then his app closes.
    mesh.setEdge(carol, alice, false); mesh.setEdge(carol, bob, false);
    const hubA = await admit(mesh, alice);
    mesh.setEdge(carol, hubA, false);
    mesh.hubs.add(hubA.myKey);
    mesh.carriers.set(bob.myKey, [hubA.myKey]);
    mesh.setEdge(bob, alice, false);
    expect(await bob.sendEdit(kept, { v: 1, ts: 1, text: "A edited" })).toEqual({ sent: 2 });
    expect(await bob.sendEdit(gone, { v: 5_001, ts: 2, text: REMOVED_TEXT, remove: true })).toEqual({ sent: 2 });
    await mesh.settle();
    expect(mesh.of(alice).map(e => e.id)).toEqual([kept, gone]);
    mesh.setEdge(bob, hubA, false);
    // Hub B is let in after the edits: neither Bob nor anyone's catch-up handed it them.
    const hubB = await admit(mesh, alice);
    mesh.setEdge(carol, hubB, false); mesh.setEdge(bob, hubB, false);
    mesh.hubs.add(hubB.myKey);
    const toHubB = (from: GroupSession) => mesh.sent.filter(f => f.frame.t === GROUP_EDIT_FRAME && f.from === from.myKey && f.to === hubB.myKey).length;
    // A member that does not count on it as a hub hands it only what it can read: none of these.
    await alice.handle(hubB.myKey, clone(hubB.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(toHubB(alice)).toBe(0);
    // Hub A counts on it: its sync asking for Bob gets the edits Hub A carries, unread, and only once.
    mesh.carriers.set(hubA.myKey, [hubB.myKey]);
    await hubA.handle(hubB.myKey, clone(hubB.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(toHubB(hubA)).toBe(2);
    await hubA.handle(hubB.myKey, clone(hubB.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(toHubB(hubA)).toBe(2);
    // As does a member of the edits' epoch that counts on it: its two, once.
    mesh.carriers.set(alice.myKey, [hubB.myKey]);
    for (let i = 0; i < 2; i++) { await alice.handle(hubB.myKey, clone(hubB.syncFrame([bob.myKey]))); await mesh.settle(); }
    expect(toHubB(alice)).toBe(2);
    expect(mesh.of(hubB)).toEqual([]);
    // Hub A leaves; Carol is back with Hub B alone, and her catch-up asks it for Bob.
    mesh.setEdge(hubA, hubB, false);
    mesh.setEdge(carol, hubB, true);
    await hubB.handle(carol.myKey, clone(carol.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.of(carol).map(e => [e.id, e.e])).toEqual([[kept, 1], [gone, 5_001]]);
    // A member let in after the messages, not a hub, is handed none of them, from a hub or a reader.
    const dave = await admit(mesh, alice);
    for (const via of [hubB, alice]) await via.handle(dave.myKey, clone(dave.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.sent.filter(f => f.frame.t === GROUP_EDIT_FRAME && f.to === dave.myKey)).toEqual([]);
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

  it("say a removal with its fallback text alone; a rm other than true is nothing", () => {
    const frame = communityEditFrame({ id, e: 5_001, ts: 5, m: REMOVED_TEXT, k: [{ k: other, o: 0, l: 3 }], sc: { kind: "task", id: "t", title: "x", status: "done" }, rm: true });
    expect(frame).toEqual({ t: COMMUNITY_EDIT_FRAME, id, v: 5_001, ts: 5, text: REMOVED_TEXT, rm: true });
    expect(parseCommunityEdit(frame, author)).toEqual({ id, e: 5_001, ts: 5, m: REMOVED_TEXT, rm: true });
    expect(parseCommunityEdit({ ...frame, v: 101 }, author)).toEqual({ id, e: 101, ts: 5, m: REMOVED_TEXT, rm: true });
    expect(parseCommunityEdit({ ...frame, m: [{ k: other, o: 0, l: 3 }], sc: { kind: "task", id: "t", title: "x", status: "done" } }, author)).toEqual({ id, e: 5_001, ts: 5, m: REMOVED_TEXT, rm: true });
    for (const bad of [{ ...frame, rm: false }, { ...frame, rm: 1 }, { ...frame, v: 5_002 }]) expect(parseCommunityEdit(bad, author)).toBeNull();
    expect(parseCommunityEdit(frame, other)).toBeNull();
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
    expect(await session.sendEdit({ id: mine, v: 5_001, ts: 1, text: REMOVED_TEXT, remove: true })).toHaveProperty("id");
    expect(await session.sendEdit({ id: mine, v: 5_001, ts: 1, text: "past a text's bound" })).toEqual({ error: "This message was edited too many times" });
    expect(out).toHaveLength(3);
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
