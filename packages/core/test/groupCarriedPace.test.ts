import { describe, expect, it } from "vitest";
import { GroupSession, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up

/**
 * Frames of an epoch from before a member was let in, which it keeps unread to hand on (WISP 902 § Catch-up, "Carried
 * unread"): taken at their author's pace, as the frames it reads, and one author's many push out only its own.
 */
describe("carried unread frames: the author's pace, and a log one author cannot take over", { timeout: 120_000 }, () => {
  /**
   * Alice, Bob and Dave share an epoch; Dave is away. Alice writes one line, Bob 300 (on no edge to Alice, so only he
   * holds them), then Carol is let in: she can read neither.
   */
  async function setup() {
    const mesh = new Mesh();
    mesh.clock = 1_000_000;
    const alice = mesh.add(GroupSession.create("Crew"), "Alice");
    const bob = await admit(mesh, alice, "Bob");
    const dave = await admit(mesh, alice, "Dave");
    const away = () => { for (const s of mesh.sessions.values()) if (s !== dave) mesh.setEdge(dave.myKey, s.myKey, false); };
    away();
    await alice.sendText("alice: a line of the old epoch");
    await mesh.settle();
    const epoch = bob.epoch;
    mesh.setEdge(alice.myKey, bob.myKey, false);
    for (let n = 0; n < 300; n++) await bob.sendText(`bob ${n}`);
    await mesh.settle();
    const sent = (from: GroupSession, to: GroupSession) => mesh.sentFrames
      .filter(f => f.from === from.myKey && f.to === to.myKey && f.frame.t === "group-msg").map(f => f.frame as GroupMessageFrame);
    const flood = sent(bob, alice), line = sent(alice, bob)[0];
    expect(flood).toHaveLength(300);
    expect(flood.every(f => f.e === epoch) && line.e === epoch).toBe(true);
    mesh.setEdge(alice.myKey, bob.myKey, true);
    const carol = await admit(mesh, alice, "Carol");
    away();
    expect(carol.epoch).toBeGreaterThan(epoch);
    // Alice's line, handed to Carol to carry for the members who can read it.
    await carol.handle(alice.myKey, clone(line));
    await carol.flush();
    const kept = (of: GroupSession) => (mesh.saved.get(carol.myKey)!.relay ?? []).filter(f => f.s === of.myKey && f.e === epoch).length;
    expect(kept(alice)).toBe(1);
    return { mesh, alice, bob, carol, dave, flood, kept };
  }

  it("one author's burst is taken at its pace: no more than a member takes of it at once", async () => {
    const { bob, carol, flood, kept, alice } = await setup();
    for (const f of flood) await carol.handle(bob.myKey, clone(f));
    await carol.flush();
    // What a member of that epoch takes of one author at once: twice its own log (`AUTHOR_BURST`).
    expect(kept(bob)).toBeLessThanOrEqual(64);
    expect(kept(alice)).toBe(1);
  });

  it("one author's frames, as many as its pace lets through, push out only its own: another's kept line stays", async () => {
    const { mesh, bob, carol, flood, kept, alice } = await setup();
    for (const [i, f] of flood.entries()) {
      if (i % 20 === 0) mesh.tick(10_000);
      await carol.handle(bob.myKey, clone(f));
    }
    await carol.flush();
    expect(kept(alice)).toBe(1);
    // The log is full of Bob's latest, the oldest of his gone.
    const bobs = (mesh.saved.get(carol.myKey)!.relay ?? []).filter(f => f.s === bob.myKey).map(f => f.n);
    expect(bobs).toHaveLength(255);
    expect(bobs).toEqual(flood.slice(-255).map(f => f.n));
  });

  it("an honest carried line still reaches the member away when it was said, after another's burst", async () => {
    const { mesh, alice, bob, carol, dave, flood } = await setup();
    for (const f of flood) await carol.handle(bob.myKey, clone(f));
    // Dave is back, on an edge to Carol alone, and asks her for Alice's lines.
    await mesh.open(dave, carol, { a: [alice.myKey] });
    expect(mesh.texts(dave)).toContain("alice: a line of the old epoch");
  });
});
