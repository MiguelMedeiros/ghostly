import { describe, expect, it, vi } from "vitest";
import { GroupSession, type GroupEditFrame } from "../src/groupSession";
import { GROUP_EDIT_FRAME } from "../src/groupEdits";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.protocol.edits

const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/identity", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/identity")>();
  return { ...actual, verify: (...args: Parameters<typeof actual.verify>) => { verified.calls++; return actual.verify(...args); } };
});

/**
 * On hubs a member hears each edit from each of its hubs, and hubs hand it on to each other: a copy of an edit taken
 * already costs what a copy of a message does since the duplicate check, nothing (no signature check, no box opened,
 * nothing to the app).
 */
describe("a private group's edit heard again", { timeout: 60_000 }, () => {
  async function group() {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Crew"), "Alice");
    const bob = await admit(mesh, alice, "Bob"), hubA = await admit(mesh, alice, "Hub A"), hubB = await admit(mesh, alice, "Hub B");
    return { mesh, alice, bob, hubA, hubB };
  }

  it("a burst of 30 edits handed again by two hubs costs no check and reaches the app once each", async () => {
    const { mesh, alice, bob, hubA, hubB } = await group();
    const ids: string[] = [];
    for (let n = 0; n < 30; n++) ids.push(((await alice.sendText(`task ${n}`)) as { id: string }).id);
    await mesh.settle();
    for (const [n, id] of ids.entries()) await alice.sendEdit(id, { v: 1, ts: 2_000 + n, text: `✅ task ${n}` });
    await mesh.settle();
    expect(mesh.edits.get(bob.myKey)!.map(e => e.m)).toEqual(ids.map((_, n) => `✅ task ${n}`));
    const frames = mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === GROUP_EDIT_FRAME).map(f => f.frame as GroupEditFrame);
    expect(frames).toHaveLength(30);
    const before = verified.calls;
    for (const frame of frames) for (const hub of [hubA, hubB]) await bob.handle(hub.myKey, clone(frame));
    expect(verified.calls - before).toBe(0);
    expect(mesh.edits.get(bob.myKey)).toHaveLength(30);
    // A later edit of the same message is no copy: checked and taken.
    await alice.sendEdit(ids[0], { v: 2, ts: 3_000, text: "✅ task 0, again" });
    await mesh.settle();
    expect(mesh.edits.get(bob.myKey)!.at(-1)).toMatchObject({ e: 2, m: "✅ task 0, again" });
  });

  it("a copy altered on the way to a number not taken yet is still checked, and refused", async () => {
    const { mesh, alice, bob, hubA } = await group();
    const id = ((await alice.sendText("mine")) as { id: string }).id;
    await mesh.settle();
    await alice.sendEdit(id, { v: 1, ts: 1, text: "fixed" });
    await mesh.settle();
    const frame = mesh.sentFrames.find(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === GROUP_EDIT_FRAME)!.frame as GroupEditFrame;
    const before = verified.calls;
    await bob.handle(hubA.myKey, { ...clone(frame), v: 2 });
    expect(verified.calls - before).toBe(1);
    expect(mesh.edits.get(bob.myKey)).toHaveLength(1);
  });
});
