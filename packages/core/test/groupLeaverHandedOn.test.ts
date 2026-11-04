import { describe, expect, it } from "vitest";
import { GroupSession, type GroupCommitFrame, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.leave, groups.remove-member

/*
 * WISP 902 § Catch-up: another member's frame is taken from a third member, kept and handed on only while its author is
 * in the roster. One who left keeps its seed and the secrets of the epochs it was in, and a copy of its state signs
 * frames for them afterwards, dated as it likes: once the leave is known, nothing of it is believed from a third member,
 * as for a removal, whether the admin marked the removal `left` or not.
 */

/** Alice (admin), Bob, Carol and Dave, all connected; then Dave's app closes. */
async function daveAway(rows = false) {
  const mesh = new Mesh();
  mesh.rows = rows;
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol"), dave = await admit(mesh, alice, "Dave");
  for (const s of [alice, bob, carol]) mesh.setEdge(dave.myKey, s.myKey, false);
  return { mesh, alice, bob, carol, dave };
}
/** Bob says goodbye and goes (`leave`), or the admin takes him out (`remove`); Alice writes on. */
async function goodbye(mesh: Mesh, alice: GroupSession, bob: GroupSession, how: "leave" | "remove") {
  let ts = 1_000;
  for (const text of ["bob 1", "bob 2", "thanks all, leaving now"]) await bob.sendText(text, ts += 1_000);
  await mesh.settle();
  if (how === "leave") await bob.leave(); else await alice.remove(bob.myKey);
  await mesh.settle();
  await alice.sendText("alice 1", ts + 60_000); await mesh.settle();
}
const handedOn = (mesh: Mesh, from: GroupSession, to: GroupSession | null, author: GroupSession) =>
  mesh.sentFrames.filter(f => f.from === from.myKey && (!to || f.to === to.myKey) && f.frame.t === "group-msg" && (f.frame as GroupMessageFrame).s === author.myKey);

describe("a member who left is not believed from another member", { timeout: 60_000 }, () => {
  it("a line a copy of a leaver's state signs after the leave, dated before it, is neither taken from a member nor handed on", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    await bob.sendText("bob 1", 2_000); await mesh.settle();
    const before = clone(bob.state);
    await bob.leave(); await mesh.settle();
    expect(alice.state.leftMarks?.[alice.epoch]).toBeTruthy();
    // A copy kept from before the leave writes on for its last epoch, dated before the leave, to Dave only: Dave was
    // away and still holds Bob as a member, so takes it over their edge.
    for (const s of [alice, carol]) mesh.setEdge(bob.myKey, s.myKey, false);
    const ghost = mesh.add(before);
    await mesh.open(ghost, dave);
    await ghost.sendText("still here", 5_000); await mesh.settle();
    expect(mesh.texts(dave)).toContain("still here");
    const words = mesh.sentFrames.filter(f => f.from === bob.myKey && f.to === dave.myKey && f.frame.t === "group-msg").at(-1)!.frame as GroupMessageFrame;
    expect(words.e).toBe(alice.epoch - 1);
    // Dave hands it on to Carol, who heard the leave: not taken, so not handed on either.
    const sentBefore = handedOn(mesh, carol, null, bob).length;
    await carol.handle(dave.myKey, clone(words)); await mesh.settle();
    expect(mesh.texts(carol)).not.toContain("still here");
    expect(carol.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    expect(handedOn(mesh, carol, null, bob)).toHaveLength(sentBefore);
    // Dave hears the leave from Carol: it is not kept to hand on, and Carol is not handed it in catch-up either.
    mesh.setEdge(bob.myKey, dave.myKey, false);
    await mesh.open(dave, carol);
    expect(dave.roster.some(([k]) => k === bob.myKey)).toBe(false);
    expect(dave.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    expect(mesh.texts(carol)).not.toContain("still here");
  });

  it("costs this: Dave, away while Bob wrote his last lines and left, does not get them from the others after the leave", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    await goodbye(mesh, alice, bob, "leave");
    expect(mesh.texts(carol)).toEqual(["bob 1", "bob 2", "thanks all, leaving now", "alice 1"]);
    expect(carol.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    mesh.setEdge(alice.myKey, carol.myKey, false);
    await mesh.open(dave, carol, { a: [alice.myKey] });
    expect(dave.roster.some(([k]) => k === bob.myKey)).toBe(false);
    expect(handedOn(mesh, carol, dave, bob)).toHaveLength(0);
    expect(mesh.texts(dave)).toEqual(["alice 1"]);
    // Handed on anyway (a stale or hostile member): not taken.
    const words = mesh.sentFrames.find(f => f.from === bob.myKey && f.frame.t === "group-msg")!.frame;
    await dave.handle(carol.myKey, clone(words));
    expect(mesh.texts(dave)).toEqual(["alice 1"]);
  });

  it("what a removed member wrote is still not handed on", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    await goodbye(mesh, alice, bob, "remove");
    expect(carol.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    await mesh.open(dave, carol, { a: [alice.myKey] });
    expect(mesh.texts(dave)).toEqual(["alice 1"]);
    // Handed on anyway (a stale or hostile member): not taken.
    const words = mesh.sentFrames.find(f => f.from === bob.myKey && f.frame.t === "group-msg")!.frame;
    await dave.handle(carol.myKey, clone(words));
    expect(mesh.texts(dave)).toEqual(["alice 1"]);
  });

  it("nor from the rows, after the app starts again", async () => {
    const { mesh, alice, bob, dave } = await daveAway(true);
    await goodbye(mesh, alice, bob, "leave");
    await alice.flush();
    const alice2 = mesh.add(clone(mesh.saved.get(alice.myKey)!));
    await mesh.open(dave, alice2);
    expect(handedOn(mesh, alice2, dave, bob)).toHaveLength(0);
    expect(mesh.texts(dave)).toEqual(["alice 1"]);
  });

  it("the admin's mark, heard after its commit, is kept and brings nothing of the leaver back", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    let ts = 1_000;
    for (const text of ["bob 1", "bob 2", "thanks all, leaving now"]) await bob.sendText(text, ts += 1_000);
    await mesh.settle();
    mesh.setEdge(alice.myKey, carol.myKey, false);
    await bob.leave(); await mesh.settle();
    // Carol hears of the commit first from an app that leaves the mark out, then with it.
    const commit = mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === carol.myKey && f.frame.t === "group-commit").at(-1)!.frame as GroupCommitFrame;
    const { left, ...bare } = commit;
    expect(left).toBeTruthy();
    await carol.handle(alice.myKey, clone(bare)); await mesh.settle();
    expect(carol.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    await carol.handle(alice.myKey, clone(commit)); await mesh.settle();
    expect(carol.state.leftMarks?.[commit.commit.e]).toBe(left);
    expect(carol.state.relay?.some(f => f.s === bob.myKey)).toBe(false);
    await mesh.open(dave, carol, { a: [alice.myKey] });
    expect(mesh.texts(dave)).toEqual([]);
  });

  it("one removed, let back in and then gone is not handed on for any epoch", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway(true);
    await bob.sendText("before removal", 2_000); await mesh.settle();
    await alice.remove(bob.myKey); await mesh.settle();
    const invite = alice.inviteFrame(), welcome = await alice.admit(bob.myKey);
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], bob.state.seedB64);
    if ("error" in joined) throw new Error(joined.error);
    const back = mesh.add(joined.state);
    await mesh.settle();
    await mesh.open(back, alice); await mesh.open(back, carol);
    await back.sendText("let back in", 3_000); await mesh.settle();
    await back.leave(); await mesh.settle();
    expect(mesh.texts(carol)).toEqual(["before removal", "let back in"]);
    // Carol's app starts again, from what it holds with its messages; Alice's is closed.
    await carol.flush();
    mesh.setEdge(alice.myKey, carol.myKey, false);
    const carol2 = mesh.add(clone(mesh.saved.get(carol.myKey)!));
    await mesh.open(dave, carol2, { a: [alice.myKey] });
    expect(handedOn(mesh, carol2, dave, bob)).toHaveLength(0);
    expect(mesh.texts(dave)).toEqual([]);
    // Handed on anyway (a stale or hostile member): not taken.
    for (const { frame } of handedOn(mesh, bob, carol, bob)) await dave.handle(carol2.myKey, clone(frame));
    expect(handedOn(mesh, bob, carol, bob)).toHaveLength(2);
    expect(mesh.texts(dave)).toEqual([]);
  });
});
