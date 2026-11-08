import { describe, expect, it } from "vitest";
import { GROUP_LIMITS, GroupSession, frameBytes, type GroupEdgeFrame, type GroupEditFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.edit

/*
 * A private group takes one member's messages and edits at a pace (`GROUP_LIMITS.messagesPerAuthor`,
 * `messageBytesPerAuthor` per `messageWindowMs`, as a community's), past a burst of the member's whole log: past it, a
 * frame is neither kept nor passed on by a hub. What another member hands on in a catch-up is not counted.
 */

/** Alice (admin), Bob (the hub), Carol and Mallory; Mallory reaches only Bob, Carol is away. */
async function group() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol"), mallory = await admit(mesh, alice, "Mallory");
  for (const s of [alice, carol]) mesh.setEdge(mallory.myKey, s.myKey, false);
  for (const s of [alice, bob]) mesh.setEdge(carol.myKey, s.myKey, false);
  // Past every answer window the admissions opened.
  mesh.clock = Date.now() + 60_000;
  // What Bob, as a hub, passes on.
  const passed: GroupEdgeFrame[] = [];
  const handle = bob.handle.bind(bob);
  bob.handle = async (from, raw) => { const out = await handle(from, raw); passed.push(...out); return out; };
  return { mesh, alice, bob, carol, mallory, passed };
}
const bytesOf = (frames: GroupEdgeFrame[]) => frames.reduce((sum, f) => sum + (f.t === "group-msg" ? frameBytes(f) : f.t === "group-edit" ? f.c.length + 400 : 0), 0);
/** The most one member's frames may weigh, taken over `ms`. */
const bound = (ms: number) => 2 * GROUP_LIMITS.outlogBytes + GROUP_LIMITS.messageBytesPerAuthor * (ms / GROUP_LIMITS.messageWindowMs);
const BIG = "x".repeat(15_000);

describe("one member's messages and edits at a pace", { timeout: 60_000 }, () => {
  it("takes and passes on a member's flood of messages only at its pace; a catch-up later brings more", async () => {
    const { mesh, bob, mallory, passed } = await group();
    const start = mesh.clock!;
    for (let i = 0; i < 100; i++) {
      mesh.clock = start + i * 300;
      await mallory.sendText(`${i} ${BIG}`, mesh.clock); await mesh.settle();
    }
    const taken = mesh.inbox.get(bob.myKey)!.filter(m => m.sender === mallory.myKey).length;
    const handedOn = passed.filter(f => f.t === "group-msg" && f.s === mallory.myKey);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(50);
    expect(handedOn).toHaveLength(taken);
    expect(bytesOf(handedOn)).toBeLessThanOrEqual(bound(30_000));
    // Not lost: a later sync hands back what Mallory still holds of it.
    mesh.clock = start + 600_000;
    await mesh.open(bob, mallory);
    expect(mesh.inbox.get(bob.myKey)!.filter(m => m.sender === mallory.myKey).length).toBeGreaterThan(taken);
  });

  it("takes and passes on a member's flood of edits only at its pace", async () => {
    const { mesh, bob, mallory, passed } = await group();
    const start = mesh.clock!;
    const sent = await mallory.sendText("status", start); await mesh.settle();
    if ("error" in sent) throw new Error(sent.error);
    for (let v = 1; v <= 100; v++) {
      mesh.clock = start + v * 300;
      await mallory.sendEdit(sent.id, { v, ts: mesh.clock, text: `${v} ${BIG}` }); await mesh.settle();
    }
    const taken = mesh.edits.get(bob.myKey)!.filter(e => e.sender === mallory.myKey).length;
    const handedOn = passed.filter((f): f is GroupEditFrame => f.t === "group-edit" && f.s === mallory.myKey);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(50);
    expect(handedOn).toHaveLength(taken);
    expect(bytesOf(handedOn)).toBeLessThanOrEqual(bound(30_000));
  });

  it("takes a member writing fast, and a catch-up of a busy hour at once", async () => {
    const { mesh, alice, bob, carol } = await group();
    const start = mesh.clock!;
    // Alice pastes ten lines at once, then talks on: a hundred in under forty seconds.
    for (let i = 0; i < 100; i++) {
      mesh.clock = start + (i < 10 ? 0 : i * 400);
      await alice.sendText(`line ${i}`, mesh.clock); await mesh.settle();
    }
    expect(mesh.texts(bob)).toHaveLength(100);
    // Carol back, Alice away: Bob hands her all hundred, as one answer, more than one member's burst.
    mesh.setEdge(alice.myKey, carol.myKey, false);
    await mesh.open(carol, bob, { a: [alice.myKey] });
    expect(mesh.texts(carol)).toEqual(Array.from({ length: 100 }, (_, i) => `line ${i}`));
  });

  it("drops a duplicate of an edit from a second hub without counting it", async () => {
    const { mesh, alice, bob, mallory } = await group();
    const start = mesh.clock!;
    const sent = await mallory.sendText("status", start); await mesh.settle();
    if ("error" in sent) throw new Error(sent.error);
    // Bob holds edit 1; Alice, a second hub, hands it on again sixty-four times: Mallory's next is still taken.
    await mallory.sendEdit(sent.id, { v: 1, ts: start, text: "one" }); await mesh.settle();
    const one = mesh.sentFrames.find(f => f.from === mallory.myKey && f.to === bob.myKey && f.frame.t === "group-edit")!.frame;
    for (let i = 0; i < 2 * GROUP_LIMITS.outlog; i++) await bob.handle(alice.myKey, clone(one));
    await mallory.sendEdit(sent.id, { v: 2, ts: start, text: "two" }); await mesh.settle();
    expect(mesh.edits.get(bob.myKey)!.filter(e => e.sender === mallory.myKey).map(e => e.m).at(-1)).toBe("two");
  });
});
