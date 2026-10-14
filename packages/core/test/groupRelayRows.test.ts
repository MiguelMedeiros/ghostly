import { describe, expect, it } from "vitest";
import { GROUP_LIMITS, GroupSession, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.remove-member

/*
 * An app that keeps each frame with the message it stored (`GroupSession`'s `onRows`): the frames handed on to a member
 * who was away are those, and the saved state carries none, so a message received no longer writes them all again.
 */

async function three(rows = true) {
  const mesh = new Mesh();
  mesh.rows = rows;
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
  return { mesh, alice, bob, carol };
}
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };
const handedOn = (mesh: Mesh, by: GroupSession, to: GroupSession, author: GroupSession) =>
  mesh.sentFrames.filter(f => f.from === by.myKey && f.to === to.myKey && f.frame.t === "group-msg" && (f.frame as GroupMessageFrame).s === author.myKey);
const bytes = (v: unknown) => JSON.stringify(v).length;

describe("the frames handed on are the ones kept with the messages", { timeout: 60_000 }, () => {
  it("the saved state carries none of them, however many came", async () => {
    const { mesh, alice, carol } = await three();
    await alice.flush();
    const empty = bytes(mesh.saved.get(alice.myKey));
    for (let i = 0; i < 50; i++) await carol.sendText(`line ${i} ${"x".repeat(200)}`, 1_000 + i);
    await mesh.settle(); await alice.flush();
    const saved = mesh.saved.get(alice.myKey)!;
    expect(saved.relay ?? []).toEqual([]);
    expect(mesh.frames.get(alice.myKey)!.size).toBe(50);
    // The state grew by what it remembers of fifty numbers, not by fifty frames (about 700 bytes each).
    expect(bytes(saved) - empty).toBeLessThan(2_000);
  });

  it("a member hands on what it received, before and after its app starts again", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("first", 1_000); await carol.sendText("second", 2_000);
    await mesh.settle(); await alice.flush();
    away(mesh, carol, [alice]);
    // Alice's app starts again from what it saved and the rows it holds.
    const alice2 = mesh.add(clone(mesh.saved.get(alice.myKey)!));
    await mesh.open(bob, alice2, { a: [carol.myKey] });
    expect(mesh.texts(bob)).toEqual(["first", "second"]);
    expect(handedOn(mesh, alice2, bob, carol)).toHaveLength(2);
  });

  it("what a state saved before held is still handed on, and leaves it as newer frames come", async () => {
    // Saved by an app from before: the frames are in the state.
    const { mesh, alice, bob, carol } = await three(false);
    away(mesh, bob, [alice, carol]);
    await carol.sendText("old one", 1_000); await carol.sendText("old two", 2_000);
    await mesh.settle(); await alice.flush();
    const before = clone(mesh.saved.get(alice.myKey)!);
    expect(before.relay).toHaveLength(2);
    // The new app starts on it.
    mesh.rows = true;
    const alice2 = mesh.add(before);
    await mesh.open(alice2, carol);
    await carol.sendText("new one", 3_000);
    await mesh.settle(); await alice2.flush();
    // The two from before stay in the state; the new one is on its row only.
    expect(mesh.saved.get(alice.myKey)!.relay).toHaveLength(2);
    expect(mesh.frames.get(alice.myKey)!.size).toBe(1);
    away(mesh, carol, [alice2]);
    await mesh.open(bob, alice2, { a: [carol.myKey] });
    expect(mesh.texts(bob)).toEqual(["old one", "old two", "new one"]);
    // Past what a member keeps, the oldest go first: the state's.
    await mesh.open(alice2, carol);
    for (let i = 0; i < GROUP_LIMITS.relay; i++) await carol.sendText(`line ${i}`, 4_000 + i);
    await mesh.settle(); await alice2.flush();
    expect(mesh.saved.get(alice.myKey)!.relay).toEqual([]);
  });

  it("a frame the state and a row both hold is the row's: the state lets go of it at the start", async () => {
    const { mesh, alice, carol } = await three(false);
    await carol.sendText("in both", 1_000);
    await mesh.settle(); await alice.flush();
    const before = clone(mesh.saved.get(alice.myKey)!);
    const frame = before.relay![0];
    let saved = before;
    const alice2 = new GroupSession(before, { save: async s => { saved = s; }, send: () => false, message: () => {}, changed: () => {} }, [frame]);
    await alice2.setNick(alice2.myKey, "Alice again");
    expect(saved.relay).toEqual([]);
  });

  it("someone out of the roster is not handed on from the rows either, after the app starts again", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("before I was removed", 1_000);
    await mesh.settle();
    await alice.remove(carol.myKey); await mesh.settle(); await alice.flush();
    expect(mesh.frames.get(alice.myKey)!.size).toBe(1);
    const alice2 = mesh.add(clone(mesh.saved.get(alice.myKey)!));
    await mesh.open(bob, alice2, { a: [carol.myKey] });
    expect(handedOn(mesh, alice2, bob, carol)).toHaveLength(0);
    expect(mesh.texts(bob)).toEqual([]);
  });

  it("a message taken again after a save was lost is kept once", async () => {
    const { mesh, alice, bob, carol } = await three();
    await carol.sendText("once", 1_000);
    await mesh.settle();
    // Alice's app is killed before the save: its state is from before the message, its row holds the frame.
    const stale = clone(mesh.saved.get(alice.myKey)!);
    expect(stale.seen[carol.myKey]).toBeUndefined();
    const alice2 = mesh.add(stale);
    await mesh.open(alice2, carol);
    away(mesh, bob, [carol]);
    const lost: unknown = { ...clone(bob.syncFrame([carol.myKey])), have: {} };
    await alice2.handle(bob.myKey, lost); await mesh.settle();
    expect(handedOn(mesh, alice2, bob, carol)).toHaveLength(1);
  });
});
