import { describe, expect, it } from "vitest";
import { randomBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import { GroupSession, type GroupEditFrame, type GroupEdgeFrame, type GroupMessageFrame } from "../src/groupSession";
import { REMOVED_TEXT } from "../src/pairedEdits";
import { Mesh, clone } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * Frames of a private group for an epoch not here yet wait for its commit or secret (WISP 902 § Catch-up). Their
 * signature says only that their key wrote them: a key no commit names, or a member's frames for an epoch that never
 * comes, take few of the places a member's real frames wait in, and none of them holds a member's lines said again
 * back for good.
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

const box = (bytes: number) => toBase64Url(randomBytes(bytes));
/** A message signed by `seedB64` for epoch `e` of `group`: it opens under no secret, so it waits until it is dropped. */
function messageFor(seedB64: string, group: string, e: number, n: number): GroupMessageFrame {
  const id = identityFromSeedB64(seedB64);
  const f = { g: group, e, s: id.pubKeyZ32, n, ts: 1_000 + n, nn: box(24), c: box(64) };
  return { t: "group-msg", ...f, sig: toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 msg", f.g, f.e, f.s, f.n, f.ts, f.nn, f.c])), id.seed)) };
}
function editFor(seedB64: string, group: string, e: number, n: number): GroupEditFrame {
  const id = identityFromSeedB64(seedB64);
  const f = { g: group, e, s: id.pubKeyZ32, n, v: 1, ts: 1_000 + n, nn: box(24), c: box(64) };
  return { t: "group-edit", ...f, sig: toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 edit", f.g, f.e, f.s, f.n, f.v, f.ts, f.nn, f.c])), id.seed)) };
}
const madeUp = () => createIdentity().seedB64;
const shown = (mesh: Mesh, who: GroupSession, text: string) => mesh.inbox.get(who.myKey)!.filter(m => m.text === text);
const LINE = "written while behind";

/** The writer's app closes; Xena is let in; the writer writes at once, under the epoch it last knew (`groupSaidAgain`). */
async function writerBehind() {
  const mesh = new Mesh();
  mesh.clock = 1_000_000;
  const alice = mesh.add(GroupSession.create("Ghosts", 1_000), "Alice");
  const bob = await letIn(mesh, alice, "Bob", 2_000), carol = await letIn(mesh, alice, "Carol", 3_000), writer = await letIn(mesh, alice, "Writer", 4_000);
  for (const s of [alice, bob, carol]) mesh.setEdge(writer.myKey, s.myKey, false);
  const xena = await letIn(mesh, alice, "Xena", 10_000, [writer]);
  const sent = await writer.sendText(LINE, 11_000);
  if (!("id" in sent)) throw new Error(sent.error);
  expect(writer.epoch).toBe(3);
  return { mesh, alice, bob, carol, writer, xena };
}
/** The writer's app is back: every edge opens, its chain catches up, and it settles. */
async function back(mesh: Mesh, writer: GroupSession, others: GroupSession[]) {
  for (const s of others) await mesh.open(writer, s);
  mesh.clock! += 6_000;
  await writer.reseal();
  await mesh.settle();
}

/** Carol misses a rotate; Bob's line after it (and, with `remove`, his delete of it) reaches her before the commit. */
async function missedRotate({ remove = false } = {}) {
  const mesh = new Mesh();
  mesh.clock = 1_000_000;
  const alice = mesh.add(GroupSession.create("Ghosts", 1_000), "Alice");
  const bob = await letIn(mesh, alice, "Bob", 2_000), carol = await letIn(mesh, alice, "Carol", 3_000), mallory = await letIn(mesh, alice, "Mallory", 4_000);
  for (const s of [alice, bob, mallory]) mesh.setEdge(carol.myKey, s.myKey, false);
  const mark = mesh.sentFrames.length;
  await alice.rotate(5_000); await mesh.settle();
  const sent = await bob.sendText("bob after the rotate", 6_000); await mesh.settle();
  if (!("id" in sent)) throw new Error(sent.error);
  if (remove) { await bob.sendEdit(sent.id, { v: 5_001, ts: 7_000, text: REMOVED_TEXT, remove: true }); await mesh.settle(); }
  const toCarol = (from: GroupSession, t: string) => mesh.sentFrames.slice(mark).filter(f => f.from === from.myKey && f.to === carol.myKey && f.frame.t === t).map(f => clone(f.frame));
  const commit = toCarol(alice, "group-commit");
  expect(commit).toHaveLength(1);
  for (const f of [...toCarol(bob, "group-msg"), ...toCarol(bob, "group-edit")]) await carol.handle(bob.myKey, f);
  expect(mesh.texts(carol)).toEqual([]);
  /** The commit Carol missed comes at last. */
  const commitComes = async () => { await carol.handle(alice.myKey, commit[0] as GroupEdgeFrame); await mesh.settle(); };
  return { mesh, alice, bob, carol, mallory, id: sent.id, commitComes };
}

describe("frames waiting for an epoch not here yet, in a private group", { timeout: 60_000 }, () => {
  it("signed by keys no commit names, on their own edge, never keep a line said again from a member let in meanwhile", async () => {
    const { mesh, alice, bob, carol, writer, xena } = await writerBehind();
    for (let i = 0; i < 64; i++) { const seed = madeUp(); await writer.handle(identityFromSeedB64(seed).pubKeyZ32, messageFor(seed, writer.id, writer.epoch + 1 + (i % 32), 0)); }
    await back(mesh, writer, [alice, bob, carol, xena]);
    expect(writer.epoch).toBe(4);
    expect(shown(mesh, xena, LINE)).toHaveLength(1);
  });

  it("of a member, for an epoch that never comes, hold a line said again back only a while, sent again or not", async () => {
    const { mesh, alice, bob, carol, writer, xena } = await writerBehind();
    let n = 0;
    await writer.handle(carol.myKey, messageFor(carol.state.seedB64, writer.id, writer.epoch + 32, n++));
    await back(mesh, writer, [alice, bob, carol, xena]);
    expect(writer.epoch).toBe(4);
    // Carol hands one more every minute: after a few minutes the line is said again all the same.
    for (let minute = 0; minute < 4; minute++) {
      mesh.clock! += 60_000;
      await writer.handle(carol.myKey, messageFor(carol.state.seedB64, writer.id, writer.epoch + 32, n++));
      await writer.reseal(); await mesh.settle();
    }
    expect(shown(mesh, xena, LINE)).toHaveLength(1);
    for (const s of [alice, bob, carol]) expect(shown(mesh, s, LINE)).toHaveLength(1);
  });

  it("of a member's flood, or of keys no commit names, never push out a real line waiting for its commit", async () => {
    const { mesh, carol, mallory, commitComes } = await missedRotate();
    for (let i = 0; i < 64; i++) await carol.handle(mallory.myKey, messageFor(mallory.state.seedB64, carol.id, carol.epoch + 32, i));
    for (let i = 0; i < 64; i++) { const seed = madeUp(); await carol.handle(identityFromSeedB64(seed).pubKeyZ32, messageFor(seed, carol.id, carol.epoch + 1, 0)); }
    await commitComes();
    expect(mesh.texts(carol)).toEqual(["bob after the rotate"]);
  });

  it("an edit waiting for its commit is not pushed out by edits a member hands on, signed by keys no commit names or its own", async () => {
    const { mesh, carol, mallory, id, commitComes } = await missedRotate({ remove: true });
    for (let i = 0; i < 32; i++) await carol.handle(mallory.myKey, editFor(madeUp(), carol.id, carol.epoch + 1 + i, 0));
    for (let i = 0; i < 32; i++) await carol.handle(mallory.myKey, editFor(mallory.state.seedB64, carol.id, carol.epoch + 32, i));
    await commitComes();
    expect(mesh.texts(carol)).toEqual(["bob after the rotate"]);
    expect(mesh.edits.get(carol.myKey)!.map(e => [e.id, e.rm])).toEqual([[id, true]]);
  });

  it("from a member, for the epoch of a commit on its way, still wait and land", async () => {
    const { mesh, carol, commitComes } = await missedRotate();
    mesh.clock! += 30_000;
    await commitComes();
    expect(mesh.texts(carol)).toEqual(["bob after the rotate"]);
  });
});
