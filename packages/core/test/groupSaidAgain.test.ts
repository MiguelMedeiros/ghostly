import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, groupMessageId, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, clone } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * Frames said again in a private group (WISP 902 · Group Mesh § Catch-up): a member whose app was closed while someone
 * was let in writes the moment it opens, under the epoch it last knew. The member let in meanwhile could never open
 * that frame (found by the 1.1 release-gate bug hunt: never delivered in 240 s). Once the writer has caught up and its
 * chain has settled, it seals the same text again, with `o` naming the first frame, under the newest epoch before any
 * admission dated after the line.
 */

/** Let in by `admin` at `at`, with edges to everyone already in except `apart`. */
async function letIn(mesh: Mesh, admin: GroupSession, name: string, at: number, apart: GroupSession[] = []): Promise<GroupSession> {
  const seed = createIdentity().seedB64, key = identityFromSeedB64(seed).pubKeyZ32;
  for (const other of apart) mesh.setEdge(key, other.myKey, false);
  const invite = admin.inviteFrame();
  const welcome = await admin.admit(key, at);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed, at);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state, name);
  await mesh.settle();
  for (const other of session.others) { const peer = mesh.sessions.get(other); if (peer && mesh.isOpen(key, other)) await mesh.open(session, peer); }
  return session;
}
const shown = (mesh: Mesh, who: GroupSession, text: string) => mesh.inbox.get(who.myKey)!.filter(m => m.text === text);
const framesTo = (mesh: Mesh, to: GroupSession, author: GroupSession) =>
  mesh.sentFrames.filter(f => f.to === to.myKey && f.frame.t === "group-msg" && (f.frame as GroupMessageFrame).s === author.myKey).map(f => f.frame as GroupMessageFrame);
const LINE = "written while behind";

/** Five members; the writer's app closes; Xena is let in; the writer writes at once, then Yann is let in after the line. */
async function behind(opts: { xena?: boolean; yann?: boolean } = { xena: true, yann: true }) {
  const mesh = new Mesh();
  mesh.clock = 1_000_000;
  const alice = mesh.add(GroupSession.create("Ghosts", 1_000), "Alice");
  const bob = await letIn(mesh, alice, "Bob", 2_000), carol = await letIn(mesh, alice, "Carol", 3_000), writer = await letIn(mesh, alice, "Writer", 4_000);
  for (const s of [alice, bob, carol]) mesh.setEdge(writer.myKey, s.myKey, false);
  const xena = opts.xena ? await letIn(mesh, alice, "Xena", 10_000, [writer]) : undefined;
  const sent = await writer.sendText(LINE, 11_000);
  if (!("id" in sent)) throw new Error(sent.error);
  expect(writer.epoch).toBe(3);
  const yann = opts.yann ? await letIn(mesh, alice, "Yann", 12_000, [writer]) : undefined;
  return { mesh, alice, bob, carol, writer, xena, yann, firstId: sent.id };
}
/** The writer's app is back: every edge opens, its chain catches up, and it settles. */
async function back(mesh: Mesh, writer: GroupSession, others: (GroupSession | undefined)[]) {
  for (const s of others) if (s) await mesh.open(writer, s);
  mesh.clock! += 6_000;
  await writer.reseal();
  await mesh.settle();
}

describe("a line written while behind on a private group's chain", { timeout: 60_000 }, () => {
  it("reaches the member let in before it was written, once its writer has caught up", async () => {
    const { mesh, alice, bob, carol, writer, xena, yann, firstId } = await behind();
    expect(firstId).toBe(groupMessageId(writer.myKey, 3, 0));
    await back(mesh, writer, [alice, bob, carol, xena, yann]);
    expect(writer.epoch).toBe(5);
    expect(shown(mesh, xena!, LINE).map(m => m.id)).toEqual([firstId]);
    for (const s of [alice, bob, carol]) expect(shown(mesh, s, LINE).map(m => m.id)).toEqual([firstId]);
    // Said again once, under Xena's epoch (the one before Yann's admission), naming the first frame.
    const copies = writer.state.sent.filter(f => f.o);
    expect(copies.map(f => [f.e, f.o, f.ts])).toEqual([[4, { e: 3, n: 0 }, 11_000]]);
    expect(writer.messageIdOf(copies[0])).toBe(firstId);
    // Looked at once: later ticks say nothing more.
    const mark = mesh.sentFrames.length;
    mesh.clock! += 60_000;
    await writer.reseal(); await mesh.settle();
    expect(mesh.sentFrames.slice(mark).filter(f => f.frame.t === "group-msg")).toEqual([]);
    expect(writer.state.alone).toEqual([]);
  });

  it("is never handed to a member let in after it, nor said again when only such members came", async () => {
    // Xena (before) and Yann (after): the copy is sealed where only Xena can read it.
    const both = await behind();
    await back(both.mesh, both.writer, [both.alice, both.bob, both.carol, both.xena, both.yann]);
    // Yann asks everyone, the writer's lines included: nothing of the writer's before his admission comes.
    for (const s of [both.alice, both.xena!, both.writer]) await both.mesh.open(both.yann!, s, { a: [both.writer.myKey] });
    expect(framesTo(both.mesh, both.yann!, both.writer)).toEqual([]);
    expect(shown(both.mesh, both.yann!, LINE)).toEqual([]);
    expect(shown(both.mesh, both.xena!, LINE)).toHaveLength(1);

    // Only Yann, let in after the line: nothing is said again, and Yann gets nothing.
    const after = await behind({ yann: true });
    await back(after.mesh, after.writer, [after.alice, after.bob, after.carol, after.yann]);
    expect(after.writer.state.sent.filter(f => f.o)).toEqual([]);
    expect(framesTo(after.mesh, after.yann!, after.writer)).toEqual([]);
    for (const s of [after.alice, after.bob, after.carol]) expect(shown(after.mesh, s, LINE)).toHaveLength(1);
  });

  it("shows once to a member that reads both, whichever comes first, and edits reach the copy's readers", async () => {
    const { mesh, alice, bob, carol, writer, xena, firstId } = await behind({ xena: true });
    // Bob's edge to the writer stays down while the writer catches up and says the line again.
    await back(mesh, writer, [alice, carol, xena]);
    expect(shown(mesh, alice, LINE)).toHaveLength(1);
    const first = writer.state.sent.find(f => f.e === 3 && f.n === 0)!, copy = writer.state.sent.find(f => f.o)!;
    // Bob gets the copy first, handed on by Alice (who read the first and showed it once), then the first from its author.
    await bob.handle(alice.myKey, clone(copy));
    await bob.handle(writer.myKey, clone(first));
    await mesh.open(writer, bob);
    expect(shown(mesh, bob, LINE).map(m => m.id)).toEqual([firstId]);
    // Xena, who could open only the copy, handed it again: still once.
    await xena!.handle(alice.myKey, clone(copy));
    expect(shown(mesh, xena!, LINE).map(m => m.id)).toEqual([firstId]);
    // A member handing a new line on cannot pass it off as said again (and hide it): `xs` covers `o`.
    mesh.setEdge(writer.myKey, carol.myKey, false);
    await writer.sendText("a new line", 21_000); await mesh.settle();
    const next = writer.state.sent[writer.state.sent.length - 1];
    await carol.handle(alice.myKey, { ...clone(next), o: { e: 3, n: 0 } });
    expect(shown(mesh, carol, "a new line")).toHaveLength(1);
    mesh.setEdge(writer.myKey, carol.myKey, true);
    // An edit of the line names one message everywhere, Xena's copy included.
    const edited = await writer.sendEdit(firstId, { v: 1, ts: 20_000, text: "edited while caught up" });
    expect(edited).toEqual({ sent: 4 });
    await mesh.settle();
    for (const s of [alice, bob, carol, xena!]) expect(mesh.edits.get(s.myKey)!.map(e => [e.id, e.m])).toEqual([[firstId, "edited while caught up"]]);
  });
});
