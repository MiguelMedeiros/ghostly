import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupMessageFrame, type GroupSyncFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.remove-member

/*
 * A member behind on the chain still hands over its own messages (WISP 9xx § Catch-up): when an edge opens and the
 * other side is epochs ahead, the member behind used to ask for the chain and say nothing else, and once it had caught
 * up nobody asked it again, so what it had sent meanwhile stayed in its log until the edge opened another time.
 */

/** Admitted by `admin`, with no edge open yet: what a joiner by link is before its first edge comes up. */
async function admitApart(mesh: Mesh, admin: GroupSession, name: string): Promise<GroupSession> {
  const seed = createIdentity().seedB64, key = identityFromSeedB64(seed).pubKeyZ32;
  for (const other of mesh.sessions.keys()) mesh.setEdge(key, other, false);
  const invite = admin.inviteFrame();
  const welcome = await admin.admit(key);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state, name);
  await mesh.settle();
  return session;
}
const messagesTo = (mesh: Mesh, to: GroupSession, from = 0) => mesh.sentFrames.slice(from).filter(f => f.to === to.myKey && f.frame.t === "group-msg").map(f => f.frame as GroupMessageFrame);
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };
/** A sync that claims to be far ahead and to have nothing, as someone fishing for messages would send. */
const aheadSync = (session: GroupSession): GroupSyncFrame => ({ t: "group-sync", g: session.id, e: session.epoch + 5, h: "none", have: {}, secrets: [] });

describe("a member behind on the chain hands over what it sent", { timeout: 60_000 }, () => {
  it("a joiner's first words, sent before any edge opened and before the next member was admitted, reach the admin", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admitApart(mesh, alice, "Bob");
    expect(await bob.sendText("first words", 1_000)).toHaveProperty("id");
    await bob.sendText("second words", 2_000);
    const carol = await admitApart(mesh, alice, "Carol");
    await mesh.settle();
    expect(alice.epoch).toBe(2);
    expect(bob.epoch).toBe(1);
    expect(mesh.texts(alice)).toEqual([]);
    // The edge to the admin opens: the admin is an epoch ahead.
    await mesh.open(bob, alice);
    expect(bob.epoch).toBe(2);
    expect(mesh.texts(alice)).toEqual(["first words", "second words"]);
    // Opening again, or the same frame once more, delivers nothing twice.
    await mesh.open(bob, alice);
    await alice.handle(bob.myKey, clone(bob.state.sent[0]));
    expect(mesh.texts(alice)).toEqual(["first words", "second words"]);
    // Carol was admitted after them: she is offered neither, whoever is ahead of whom.
    const mark = mesh.sentFrames.length;
    await mesh.open(carol, bob);
    await mesh.open(carol, alice);
    expect(messagesTo(mesh, carol, mark)).toEqual([]);
    expect(mesh.texts(carol)).toEqual([]);
    // What Bob says now reaches both.
    await bob.sendText("third words", 3_000); await mesh.settle();
    expect(mesh.texts(alice)).toEqual(["first words", "second words", "third words"]);
    expect(mesh.texts(carol)).toEqual(["third words"]);
  });

  it("a sync from someone ahead, repeated before the member caught up, delivers each message once", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admitApart(mesh, alice, "Bob");
    await bob.sendText("only once", 1_000);
    await alice.rotate();
    mesh.setEdge(alice.myKey, bob.myKey, true);
    // Two syncs of the admin, both made before it had anything of Bob's.
    const first = clone(alice.syncFrame()), second = clone(alice.syncFrame());
    const mark = mesh.sentFrames.length;
    await bob.handle(alice.myKey, first); await bob.handle(alice.myKey, second);
    await mesh.settle();
    expect(messagesTo(mesh, alice, mark).filter(f => f.s === bob.myKey).length).toBeGreaterThanOrEqual(2);
    expect(mesh.texts(alice)).toEqual(["only once"]);
    // Once the admin has it, its sync says so and nothing is sent again.
    const after = mesh.sentFrames.length;
    await mesh.open(bob, alice);
    expect(messagesTo(mesh, alice, after)).toEqual([]);
    expect(mesh.texts(alice)).toEqual(["only once"]);
  });

  it("a member away during a commit hands over what it sent meanwhile, in order, to those who were in that epoch only", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    away(mesh, bob, [alice, carol]);
    await bob.sendText("away one", 1_000); await bob.sendText("away two", 2_000);
    const dave = await admitApart(mesh, alice, "Dave");
    await mesh.open(dave, alice); await mesh.open(dave, carol);
    expect(bob.epoch).toBe(alice.epoch - 1);
    const mark = mesh.sentFrames.length;
    await mesh.open(bob, alice);
    expect(mesh.texts(alice)).toEqual(["away one", "away two"]);
    await mesh.open(bob, carol);
    expect(mesh.texts(carol)).toEqual(["away one", "away two"]);
    await mesh.open(bob, dave);
    // Dave joined after them.
    expect(messagesTo(mesh, dave, mark)).toEqual([]);
    expect(mesh.texts(dave)).toEqual([]);
  });

  it("offers nothing for an epoch the other side was not in, and nothing to someone removed", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
    // Carol is away while Bob is removed, and says something in the epoch she still believes in.
    away(mesh, carol, [alice, bob]);
    await carol.sendText("before I knew", 1_000);
    const old = carol.epoch;
    await alice.remove(bob.myKey); await mesh.settle();
    await alice.sendText("after the removal", 2_000); await mesh.settle();
    expect(bob.status).toBe("removed");
    // Bob's key claims to be ahead, to the admin: it is not in the roster, so it is answered nothing.
    let mark = mesh.sentFrames.length;
    await alice.handle(bob.myKey, aheadSync(alice)); await mesh.settle();
    expect(mesh.sentFrames.slice(mark).filter(f => f.to === bob.myKey)).toEqual([]);
    // To Carol, who has not heard of the removal: only what she sent in the epoch Bob was in, as it went to him then.
    mark = mesh.sentFrames.length;
    await carol.handle(bob.myKey, aheadSync(carol)); await mesh.settle();
    expect(messagesTo(mesh, bob, mark).map(f => f.e)).toEqual([old]);
    // Carol catches up and speaks in the new epoch: Bob's key gets nothing of it, whatever it claims.
    await mesh.open(carol, alice);
    expect(carol.epoch).toBe(old + 1);
    expect(mesh.texts(carol)).toContain("after the removal");
    await carol.sendText("among us two", 3_000); await mesh.settle();
    mark = mesh.sentFrames.length;
    await carol.handle(bob.myKey, aheadSync(carol)); await alice.handle(bob.myKey, aheadSync(alice)); await mesh.settle();
    expect(mesh.sentFrames.slice(mark).filter(f => f.to === bob.myKey)).toEqual([]);
    expect(messagesTo(mesh, bob).every(f => f.e <= old)).toBe(true);
    expect(mesh.texts(bob)).not.toContain("among us two");
    expect(mesh.texts(bob)).not.toContain("after the removal");
  });
});
