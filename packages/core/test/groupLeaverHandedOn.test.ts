import { describe, expect, it } from "vitest";
import { GroupSession, type GroupMessageFrame, type GroupSyncFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.leave, groups.remove-member

/*
 * WISP 902 § Catch-up (revision 2026-10-13): what a member wrote before it left (its removal marked `left` by the
 * admin) is still kept, taken and handed on to the members of those epochs; what a removed member wrote is not.
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
const handedOn = (mesh: Mesh, from: GroupSession, to: GroupSession, author: GroupSession) =>
  mesh.sentFrames.filter(f => f.from === from.myKey && f.to === to.myKey && f.frame.t === "group-msg" && (f.frame as GroupMessageFrame).s === author.myKey);

describe("what a member wrote before it left reaches the members who were away", { timeout: 60_000 }, () => {
  it("Dave, back after Bob said goodbye and left, reads Bob's last lines among the others", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    await goodbye(mesh, alice, bob, "leave");
    expect(mesh.texts(carol)).toEqual(["bob 1", "bob 2", "thanks all, leaving now", "alice 1"]);
    // Alice's app is closed by then: Carol is the only one Dave meets.
    mesh.setEdge(alice.myKey, carol.myKey, false);
    await mesh.open(dave, carol, { a: [alice.myKey] });
    expect(dave.roster.some(([k]) => k === bob.myKey)).toBe(false);
    expect(mesh.texts(dave)).toEqual(["bob 1", "bob 2", "thanks all, leaving now", "alice 1"]);
    expect(mesh.inbox.get(dave.myKey)!.filter(m => m.sender === bob.myKey).every(m => !!m.frame)).toBe(true);
    // Dave keeps them to hand on in turn.
    expect(dave.state.relay?.filter(f => f.s === bob.myKey)).toHaveLength(3);
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

  it("a member who left is handed on from the rows too, after the app starts again", async () => {
    const { mesh, alice, bob, dave } = await daveAway(true);
    await goodbye(mesh, alice, bob, "leave");
    await alice.flush();
    const alice2 = mesh.add(clone(mesh.saved.get(alice.myKey)!));
    await mesh.open(dave, alice2);
    expect(handedOn(mesh, alice2, dave, bob)).toHaveLength(3);
    expect(mesh.texts(dave)).toEqual(["bob 1", "bob 2", "thanks all, leaving now", "alice 1"]);
  });

  it("goes to each member once, so an app that does not take them is not sent them at every sync", async () => {
    const { mesh, alice, bob, carol, dave } = await daveAway();
    await goodbye(mesh, alice, bob, "leave");
    // An app from before: Bob's lines are not in what it says it has, however often it asks.
    const sync = clone(dave.syncFrame()) as GroupSyncFrame;
    for (let i = 0; i < 3; i++) { await carol.handle(dave.myKey, clone(sync)); await mesh.settle(); }
    expect(handedOn(mesh, carol, dave, bob)).toHaveLength(3);
  });
});
