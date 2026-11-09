import { describe, expect, it } from "vitest";
import { GROUP_LIMITS, GroupSession, frameBytes, type GroupEdgeFrame, type GroupEditFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.edit

/*
 * A private group takes one member's messages and edits at a pace (`GROUP_LIMITS.messagesPerAuthor`,
 * `messageBytesPerAuthor` per `messageWindowMs`, as a community's), past a burst of the member's whole log: past it, a
 * frame is neither kept nor passed on by a hub. What another member hands on in a catch-up is counted too, and may go
 * one catch-up past it.
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

  it("counts what a member hands on in its answer to my sync to its author, past one catch-up's worth", async () => {
    const { mesh, bob, carol, mallory } = await group();
    const start = mesh.clock!;
    for (let i = 0; i < 600; i++) await mallory.sendText(`${i}`, start);
    await mesh.settle();
    const frames = mesh.sentFrames.filter(f => f.from === mallory.myKey && f.to === bob.myKey && f.frame.t === "group-msg").map(f => f.frame);
    expect(frames).toHaveLength(600);
    // Carol syncs Bob, asking for Mallory; Bob answers with every frame Mallory signs, ten a second for a minute.
    carol.syncFrame([mallory.myKey], bob.myKey);
    for (const [i, frame] of frames.entries()) { mesh.clock = start + i * 100; await carol.handle(bob.myKey, clone(frame)); }
    const taken = mesh.inbox.get(carol.myKey)!.filter(m => m.sender === mallory.myKey).length;
    expect(taken).toBeLessThanOrEqual(2 * GROUP_LIMITS.outlog + GROUP_LIMITS.relay + GROUP_LIMITS.messagesPerAuthor * 60_000 / GROUP_LIMITS.messageWindowMs);
  });

  it("counts edits handed on in an answer to my sync to their author, past one answer's worth", async () => {
    const { mesh, bob, carol, mallory } = await group();
    const start = mesh.clock!;
    for (let m = 0; m < 3; m++) {
      const sent = await mallory.sendText(`status ${m}`, start);
      if ("error" in sent) throw new Error(sent.error);
      for (let v = 1; v <= 100; v++) await mallory.sendEdit(sent.id, { v, ts: start, text: `${v}` });
    }
    await mesh.settle();
    const edits = mesh.sentFrames.filter(f => f.from === mallory.myKey && f.to === bob.myKey && f.frame.t === "group-edit").map(f => f.frame);
    expect(edits).toHaveLength(300);
    carol.syncFrame([mallory.myKey], bob.myKey);
    for (const [i, frame] of edits.entries()) { mesh.clock = start + i * 10; await carol.handle(bob.myKey, clone(frame)); }
    const taken = mesh.edits.get(carol.myKey)!.filter(e => e.sender === mallory.myKey).length;
    expect(taken).toBeLessThanOrEqual(2 * GROUP_LIMITS.outlog + GROUP_LIMITS.handOnEdits + GROUP_LIMITS.messagesPerAuthor);
  });

  it("keeps an answer open on what it hands me, not on a copy I hold already", async () => {
    const { mesh, alice, bob, carol } = await group();
    const start = mesh.clock!;
    await alice.sendText("once", start); await mesh.settle();
    const once = mesh.sentFrames.find(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-msg")!.frame;
    await carol.handle(bob.myKey, clone(once));
    // Carol syncs Bob; Bob hands her nothing new, only that copy again every four seconds.
    carol.syncFrame([], bob.myKey);
    for (let s = 4; s <= 60; s += 4) { mesh.clock = start + s * 1000; await carol.handle(bob.myKey, clone(once)); }
    // A minute on, what Bob says is his own, live, not an answer to a sync long over.
    mesh.clock = start + 62_000;
    await bob.sendText("live", mesh.clock);
    const said = [...mesh.sentFrames].reverse().find(f => f.from === bob.myKey && f.frame.t === "group-msg")!.frame;
    await carol.handle(bob.myKey, clone(said));
    expect(mesh.inbox.get(carol.myKey)!.find(m => m.text === "live")?.live).toBe(true);
  });
});

/**
 * Alice, Bob and Carol all online the whole time; Alice sends a line at each of `at` (ms from the start), then one more a
 * minute later, and every edge opens again a few times, half a minute apart, as the syncs of the members' apps do.
 */
async function online(at: number[]) {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
  const start = Date.now() + 60_000;
  for (const [i, ms] of at.entries()) {
    mesh.clock = start + ms;
    await alice.sendText(`line ${i}`, mesh.clock); await mesh.settle();
  }
  const live = mesh.texts(bob).filter(t => t.startsWith("line ")).length;
  mesh.clock = start + at[at.length - 1] + 60_000;
  await alice.sendText("later", mesh.clock); await mesh.settle();
  for (let round = 0; round < 4; round++) {
    mesh.tick(30_000);
    for (const [a, b] of [[alice, bob], [alice, carol], [bob, carol]] as const) await mesh.open(a, b);
  }
  const lines = [...at.map((_, i) => `line ${i}`), "later"];
  const missing = (s: GroupSession) => lines.filter(t => !mesh.texts(s).includes(t));
  return { live, bob: missing(bob), carol: missing(carol), owed: alice.state.owed?.length ?? 0, duplicates: [bob, carol].some(s => new Set(mesh.texts(s)).size !== mesh.texts(s).length) };
}
const burst = (n: number, gap: number) => Array.from({ length: n }, (_, i) => i * gap);
/** Five forwards of thirty messages each (`FORWARD_MAX_MESSAGES`), `apart` ms between them. */
const forwards = (gap: number, apart: number) => Array.from({ length: 150 }, (_, i) => Math.floor(i / 30) * apart + (i % 30) * gap);
/** A bot sending every `every` ms for `ms`. */
const bot = (every: number, ms: number) => Array.from({ length: Math.floor(ms / every) }, (_, i) => i * every);

describe("one member's messages past its pace, every member online", { timeout: 120_000 }, () => {
  it.each([
    ["100 at once", burst(100, 0)], ["100, 10 ms apart", burst(100, 10)], ["100, 50 ms apart", burst(100, 50)],
    ["130 at once", burst(130, 0)], ["130, 10 ms apart", burst(130, 10)], ["130, 50 ms apart", burst(130, 50)],
    ["5 forwards of 30, 5 s apart", forwards(0, 5_000)], ["5 forwards of 30, 10 ms apart within, 5 s apart", forwards(10, 5_000)],
    ["5 forwards of 30, 50 ms apart within, 5 s apart", forwards(50, 5_000)],
    ["5 a second for a minute", bot(200, 60_000)], ["a line every 180 ms for a minute", bot(180, 60_000)],
    ["a line every 220 ms for a minute", bot(220, 60_000)],
  ])("%s: none lost for any member", async (_, at) => {
    const end = await online(at);
    // The pace still bounds what Alice costs each member live.
    expect(end.live).toBeLessThan(at.length);
    // And what Alice kept past her log for them is let go once both showed they hold it.
    expect(end).toMatchObject({ bob: [], carol: [], owed: 0, duplicates: false });
  });

  it.each([
    ["40 at once", burst(40, 0)], ["70 at once", burst(70, 0)], ["5 forwards of 30, 10 s apart", forwards(0, 10_000)],
    ["2 a second for two minutes", bot(500, 120_000)],
  ])("%s: none lost (controls)", async (_, at) => {
    expect(await online(at)).toMatchObject({ bob: [], carol: [], owed: 0, duplicates: false });
  });

  it("a burst of 100 is taken live up to the burst a member allows, as before", async () => {
    expect((await online(burst(100, 0))).live).toBe(2 * GROUP_LIMITS.outlog);
  });
});
