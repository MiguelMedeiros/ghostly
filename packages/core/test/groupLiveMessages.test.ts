import { describe, expect, it } from "vitest";
import { GroupSession, type GroupEdgeFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A member's message that came straight from its author, as it was written, says how far the author's clock is from
 * mine: the app reads the time it says by that (a member whose clock runs minutes behind is still heard). Only such a
 * message: one another member handed on, or one in the author's answer to my sync (a catch-up), may have waited for
 * minutes or hours, and would take that wait for the author's clock.
 */
async function group() {
  const mesh = new Mesh();
  mesh.clock = Date.UTC(2026, 9, 14, 12, 0);
  const alice = mesh.add(GroupSession.create("Sala"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  const carol = await admit(mesh, alice, "Carol");
  // Past the answers of the syncs the edges opened with.
  mesh.clock += 60_000;
  return { mesh, alice, bob, carol };
}

const got = (mesh: Mesh, at: GroupSession, text: string) => mesh.inbox.get(at.myKey)!.find(m => m.text === text);

describe("a member's message is live when it came straight from its author", () => {
  it("over the author's own edge, as it was written: live", async () => {
    const { mesh, alice, bob } = await group();
    await bob.sendText("hello", mesh.clock!);
    await mesh.settle();
    expect(got(mesh, alice, "hello")?.live).toBe(true);
  });

  it("handed on by another member: not live", async () => {
    const { mesh, alice, bob, carol } = await group();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await bob.sendText("through Carol", mesh.clock!);
    await mesh.settle();
    const frame = mesh.sentFrames.find(f => f.from === bob.myKey && f.to === carol.myKey && f.frame.t === "group-msg")!.frame;
    await alice.handle(carol.myKey, clone(frame) as GroupEdgeFrame);
    expect(got(mesh, alice, "through Carol")).toBeDefined();
    expect(got(mesh, alice, "through Carol")?.live).toBeUndefined();
  });

  it("in the author's answer to my sync, a catch-up: not live; what it writes once the answer is over is", async () => {
    const { mesh, alice, bob } = await group();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await bob.sendText("while you were away", mesh.clock!);
    await mesh.settle();
    mesh.clock! += 10 * 60_000;
    await mesh.open(alice, bob);
    expect(got(mesh, alice, "while you were away")).toBeDefined();
    expect(got(mesh, alice, "while you were away")?.live).toBeUndefined();
    mesh.clock! += 10_000;
    await bob.sendText("back", mesh.clock!);
    await mesh.settle();
    expect(got(mesh, alice, "back")?.live).toBe(true);
  });
});
