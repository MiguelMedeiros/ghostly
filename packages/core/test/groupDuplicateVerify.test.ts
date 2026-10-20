import { describe, expect, it, vi } from "vitest";
import { GroupSession, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up

const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/identity", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/identity")>();
  return { ...actual, verify: (...args: Parameters<typeof actual.verify>) => { verified.calls++; return actual.verify(...args); } };
});

async function group(size: number) {
  const mesh = new Mesh();
  const admin = mesh.add(GroupSession.create("Ghosts"), "Admin");
  const members = [admin];
  for (let i = 1; i < size; i++) members.push(await admit(mesh, admin, `M${i}`));
  return { mesh, members };
}

/** What a member's own messages cost to check: `count` of them, each sent while all edges are open. */
async function sendAll(mesh: Mesh, members: GroupSession[], count: number): Promise<void> {
  for (let i = 0; i < count; i++) for (const m of members) { await m.sendText(`${m.myKey.slice(0, 4)} ${i}`, 1_000 + i); await mesh.settle(); }
}

describe("a private group's message heard again", { timeout: 60_000 }, () => {
  it("costs no signature check, whether its author or another member hands it on again", async () => {
    const { mesh, members: [alice, bob, carol] } = await group(3);
    await alice.sendText("hello"); await mesh.settle();
    const frame = mesh.sentFrames.find(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-msg")!.frame as GroupMessageFrame;
    expect(mesh.texts(bob)).toEqual(["hello"]);
    const before = verified.calls;
    await bob.handle(alice.myKey, clone(frame));
    await bob.handle(carol.myKey, clone(frame));
    expect(verified.calls - before).toBe(0);
    expect(mesh.texts(bob)).toEqual(["hello"]);
  });

  it("a stripped copy is still checked and shown, and a whole one still completes it", async () => {
    const { mesh, members: [alice, bob, carol] } = await group(3);
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await alice.sendText("hello"); await mesh.settle();
    const whole = mesh.sentFrames.find(f => f.from === alice.myKey && f.to === carol.myKey && f.frame.t === "group-msg")!.frame as GroupMessageFrame;
    const stripped = clone(whole); delete stripped.xs;
    let before = verified.calls;
    await bob.handle(carol.myKey, clone(stripped));
    expect(verified.calls - before).toBe(1);
    // Shown, not marked seen: the same stripped copy again is checked, then dropped as provisional.
    before = verified.calls;
    await bob.handle(carol.myKey, clone(stripped));
    expect(verified.calls - before).toBe(1);
    await bob.handle(carol.myKey, clone(whole));
    const got = mesh.inbox.get(bob.myKey)!;
    expect(got.map(m => m.text)).toEqual(["hello", "hello"]);
    expect(got[1].completes).toBe(true);
    // Now seen: no check at all.
    before = verified.calls;
    await bob.handle(carol.myKey, clone(whole));
    expect(verified.calls - before).toBe(0);
  });

  for (const size of [5, 8]) {
    it(`mesh of ${size}: a member back from away is handed each message by every other member`, async () => {
      const { mesh, members } = await group(size);
      const late = members[size - 1], others = members.slice(0, -1);
      for (const o of others) mesh.setEdge(late.myKey, o.myKey, false);
      const live = { calls: verified.calls };
      await sendAll(mesh, others, 3);
      live.calls = verified.calls - live.calls;
      const handled = mesh.sentFrames.length, before = verified.calls;
      // Back: its edges open together, each sync asking for every other member (whose edges were down when it went),
      // before any answer comes, so every member hands on the same messages.
      for (const o of others) mesh.setEdge(late.myKey, o.myKey, true);
      const syncs = others.map(o => [o.handle(late.myKey, clone(late.syncFrame(others.filter(x => x !== o).map(x => x.myKey)))), late.handle(o.myKey, clone(o.syncFrame()))]);
      await Promise.all(syncs.flat());
      await mesh.settle();
      const catchUp = verified.calls - before;
      const copies = mesh.sentFrames.slice(handled).filter(f => f.to === late.myKey && f.frame.t === "group-msg").length;
      const texts = mesh.texts(late).length;
      expect(texts).toBe(others.length * 3);
      console.log(`mesh ${size}: live ${live.calls} checks for ${others.length * 3} messages × ${size - 2} receivers; catch-up ${copies} copies of ${texts} messages → ${catchUp} checks`);
      // One check per message read, one more per handed-on copy taken whole (its `xs`); none per copy dropped.
      expect(catchUp).toBeLessThanOrEqual(texts * 2);
    });
  }
});
