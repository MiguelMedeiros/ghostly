import { describe, expect, it } from "vitest";
import { GroupSession, type GroupState } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.send, groups.catch-up

/*
 * A member's app killed while it sends a text (kill -9, out of memory, a tab closed): what it saved and stored up to
 * that point is all it has when it opens again. Its counter was saved only after the text's row was stored, so an app
 * killed in between gave its next text the same number: the first stayed "sent" here and reached nobody, and the
 * members held the next text under its id (agents#2946). Now the counter and the frame are saved first.
 */

/** What Alice's app keeps on disk: her saved state, and her rows (one per id, as the app's store keeps them). */
interface Disk { state: GroupState; rows: Map<string, string> }

/**
 * Where Alice's app is killed: in the hook call numbered `step` (1 is the first, saves and stored rows alike), before or
 * after it did its work; or right after the row of the text `afterRowOf` is stored.
 */
interface Kill { step?: number; after?: boolean; afterRowOf?: string }

async function group() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  const carol = await admit(mesh, alice, "Carol");
  await alice.flush(); await bob.flush(); await carol.flush();
  const disk: Disk = { state: clone(mesh.saved.get(alice.myKey)!), rows: new Map() };
  return { mesh, bob, carol, disk, key: alice.myKey };
}

/** Alice's app opened from her disk; `kill`: the hook call that kills it. Nothing it does after that reaches anyone. */
function open(mesh: Mesh, disk: Disk, kill?: Kill) {
  let step = 0, dead = false;
  const pending: Promise<unknown>[] = [];
  const hook = (work: () => void, text?: string) => {
    if (dead) throw new Error("killed");
    step++;
    if (kill && step === kill.step && !kill.after) { dead = true; throw new Error("killed"); }
    work();
    if (kill && ((step === kill.step && kill.after) || (text !== undefined && text === kill.afterRowOf))) { dead = true; throw new Error("killed"); }
  };
  const session: GroupSession = new GroupSession(clone(disk.state), {
    save: async s => { hook(() => { disk.state = clone(s); }); },
    message: m => { hook(() => { if (!disk.rows.has(m.id)) disk.rows.set(m.id, m.text); }, m.text); },
    send: (to, frame) => {
      const target = mesh.sessions.get(to);
      if (dead || !target || !mesh.isOpen(session.myKey, to)) return false;
      pending.push(target.handle(session.myKey, clone(frame)));
      return true;
    },
    changed: () => {},
  });
  mesh.sessions.set(session.myKey, session);
  return {
    session,
    get dead() { return dead; },
    settle: async () => { do { while (pending.length) await Promise.all(pending.splice(0)); await mesh.settle(); } while (pending.length); },
  };
}

/** Alice's app killed (`kill`) while it sends `texts` one after another; what each send answered. */
async function burst(mesh: Mesh, disk: Disk, texts: string[], kill: Kill) {
  const app = open(mesh, disk, kill);
  const answered: string[] = [];
  for (const text of texts) {
    if (app.dead) break;
    const sent = await app.session.sendText(text).catch(() => undefined);
    if (sent && "id" in sent) answered.push(sent.id);
    await app.settle();
  }
  // The edges of a killed app close.
  for (const other of app.session.others) mesh.setEdge(app.session.myKey, other, false);
  return answered;
}

/** Alice's app opened again: its edges open (each side's sync), then it sends `probe`. */
async function reopen(mesh: Mesh, disk: Disk, probe: string, rows?: (s: GroupSession) => void) {
  const app = open(mesh, disk);
  rows?.(app.session);
  for (const other of app.session.others) await mesh.open(app.session, mesh.sessions.get(other)!);
  await app.settle();
  const sent = await app.session.sendText(probe);
  if (!("id" in sent)) throw new Error(sent.error);
  await app.settle();
  return { app, probeId: sent.id };
}

/** Per member, message id → the texts it holds under it (each id once, one text). */
function heldBy(mesh: Mesh, member: GroupSession, author: string): Map<string, string[]> {
  const held = new Map<string, string[]>();
  for (const m of mesh.inbox.get(member.myKey)!) if (m.sender === author) held.set(m.id, [...held.get(m.id) ?? [], m.text]);
  return held;
}

/** Everything the sender and the members hold agrees: one text per id, and each text the sender shows went to each member once. */
function expectAgreement(mesh: Mesh, disk: Disk, author: string, members: GroupSession[]) {
  const mine = [...disk.rows].filter(([id]) => id.startsWith(`${author}:`));
  for (const member of members) {
    const held = heldBy(mesh, member, author);
    // Under each id the member holds the text the sender holds there, once.
    for (const [id, texts] of held) expect({ id, texts }).toEqual({ id, texts: [disk.rows.get(id)] });
    // And each text the sender shows as sent reached it.
    for (const [id, text] of mine) expect({ id, held: held.get(id) }).toEqual({ id, held: [text] });
  }
}

describe("a private group's text when the sender's app is killed mid-send", { timeout: 60_000 }, () => {
  it("killed after the text's row is stored: the next text gets a new id, and the interrupted one reaches every member once", async () => {
    const { mesh, bob, carol, disk, key } = await group();
    await burst(mesh, disk, ["one", "two", "three"], { afterRowOf: "two" });
    // The kill: in the second send, right after its row was stored. Its row says "sent" here.
    const killed = [...disk.rows].find(([, text]) => text === "two");
    expect(killed).toBeDefined();
    const { probeId } = await reopen(mesh, disk, "probe");
    // The bug: the probe got the interrupted text's id.
    expect(probeId).not.toBe(killed![0]);
    expect(disk.rows.get(probeId)).toBe("probe");
    expectAgreement(mesh, disk, key, [bob, carol]);
    expect(mesh.texts(bob).filter(t => t === "two")).toEqual(["two"]);
  });

  it("killed before the text's row is stored: no row and no id given twice", async () => {
    const { mesh, bob, carol, disk, key } = await group();
    // The first hook call of the first send: before any row of it.
    await burst(mesh, disk, ["one", "two"], { step: 1 });
    expect([...disk.rows.values()]).not.toContain("two");
    const { probeId } = await reopen(mesh, disk, "probe");
    expect(disk.rows.get(probeId)).toBe("probe");
    expectAgreement(mesh, disk, key, [bob, carol]);
  });

  it("killed at any point of a burst: sender and members never hold two texts under one id, and nothing shown as sent is lost", async () => {
    for (let step = 1; step <= 12; step++) {
      for (const after of [false, true]) {
        const { mesh, bob, carol, disk, key } = await group();
        await burst(mesh, disk, ["a", "b", "c", "d", "e"], { step, after });
        const { probeId } = await reopen(mesh, disk, "probe");
        expect({ step, after, probe: disk.rows.get(probeId) }).toEqual({ step, after, probe: "probe" });
        expect({ step, after, ids: new Set(disk.rows.keys()).size }).toEqual({ step, after, ids: disk.rows.size });
        expectAgreement(mesh, disk, key, [bob, carol]);
      }
    }
  });

  it("killed after its counter and frame were saved: opened again, the text is stored and said on the next tick, with no send", async () => {
    const { mesh, bob, carol, disk, key } = await group();
    // The kill: right after the first save of the send (on dev, its row came first, so this is after the row).
    await burst(mesh, disk, ["one"], { step: 1, after: true });
    const app = open(mesh, disk);
    for (const other of app.session.others) await mesh.open(app.session, mesh.sessions.get(other)!);
    await app.session.resume();
    await app.settle();
    expect([...disk.rows.values()]).toEqual(["one"]);
    expectAgreement(mesh, disk, key, [bob, carol]);
  });

  it("a row an older app left behind (its counter never saved): the next text still gets a number above it", async () => {
    const { mesh, bob, disk } = await group();
    const app = open(mesh, disk);
    expect(await app.session.sendText("one")).toHaveProperty("id");
    await app.settle();
    // An older app killed after storing the row of number 1 but before saving its counter: the state says 1 is next.
    const before = clone(disk.state);
    expect(await app.session.sendText("residue")).toHaveProperty("id");
    disk.state = before;
    for (const other of app.session.others) mesh.setEdge(app.session.myKey, other, false);
    const { probeId } = await reopen(mesh, disk, "probe", s => s.ownRows([...disk.rows.keys()].map(id => {
      const [, e, n] = id.split(":");
      return { epoch: Number(e), seq: Number(n) };
    })));
    expect(disk.rows.get(probeId)).toBe("probe");
    expect([...disk.rows.values()]).toEqual(["one", "residue", "probe"]);
    expect(heldBy(mesh, bob, app.session.myKey).get(probeId)).toEqual(["probe"]);
  });

  it("a row an older app left behind, read once: a later start that reads no row still numbers above it", async () => {
    const { mesh, bob, disk } = await group();
    const app = open(mesh, disk);
    expect(await app.session.sendText("one")).toHaveProperty("id");
    await app.settle();
    const before = clone(disk.state);
    expect(await app.session.sendText("residue")).toHaveProperty("id");
    disk.state = before;
    for (const other of app.session.others) mesh.setEdge(app.session.myKey, other, false);
    // A start reads the rows (`ownRows`) and sends nothing: what they hold is saved with the state.
    const read = open(mesh, disk);
    read.session.ownRows([...disk.rows.keys()].map(id => { const [, e, n] = id.split(":"); return { epoch: Number(e), seq: Number(n) }; }));
    await read.session.flush();
    for (const other of read.session.others) mesh.setEdge(read.session.myKey, other, false);
    // The next start reads none of them.
    const { app: later, probeId } = await reopen(mesh, disk, "probe");
    expect([...disk.rows.values()]).toEqual(["one", "residue", "probe"]);
    expect(heldBy(mesh, bob, app.session.myKey).get(probeId)).toEqual(["probe"]);
    expect(later.session.rowsRead).toBe(true);
  });

  it("a row whose store fails: not sent, never said later, and the next text goes as usual", async () => {
    const { mesh, bob, disk } = await group();
    let fail = true;
    const session = new GroupSession(clone(disk.state), {
      save: async s => { disk.state = clone(s); },
      message: m => { if (fail) throw new Error("disk full"); disk.rows.set(m.id, m.text); },
      send: (to, frame) => { const t = mesh.sessions.get(to); if (!t) return false; void t.handle(session.myKey, clone(frame)); return true; },
      changed: () => {},
    });
    mesh.sessions.set(session.myKey, session);
    await expect(session.sendText("lost")).rejects.toThrow("disk full");
    fail = false;
    const sent = await session.sendText("next");
    await mesh.settle();
    await session.flush();
    expect(sent).toHaveProperty("id");
    expect(disk.state.unsaid ?? []).toEqual([]);
    expect(disk.state.sent.length).toBe(1);
    expect(heldBy(mesh, bob, session.myKey).get((sent as { id: string }).id)).toEqual(["next"]);
    expect(mesh.texts(bob)).not.toContain("lost");
  });
});
