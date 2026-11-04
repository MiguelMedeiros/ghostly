import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupState } from "../src/groupSession";
import { REMOVED_TEXT } from "../src/pairedEdits";
// covers: groups.protocol.edits

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Members of a private group, each pair on an edge that delivers at once (`setEdge` closes one). Each app notes the
 * messages deleted for everyone (`gone`), as the engine's `removedIds` does, and stores no copy of one.
 */
class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly messages = new Map<string, GroupIncomingMessage[]>();
  readonly gone = new Map<string, Set<string>>();
  readonly sent: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  private closed = new Set<string>();
  private pending: Promise<unknown>[] = [];
  add(state: GroupState): GroupSession {
    const gone = new Set<string>();
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame) => {
        if (this.closed.has([session.myKey, to].sort().join("|"))) return false;
        this.sent.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (target) this.pending.push(target.handle(session.myKey, clone(frame)));
        return true;
      },
      message: m => { if (!gone.has(m.id)) this.messages.get(session.myKey)!.push(m); },
      edit: e => { if (e.rm) gone.add(e.id); },
      removed: id => gone.has(id),
      changed: () => {},
    });
    this.sessions.set(session.myKey, session);
    this.messages.set(session.myKey, []);
    this.gone.set(session.myKey, gone);
    return session;
  }
  setEdge(a: GroupSession, b: GroupSession, open: boolean): void {
    const key = [a.myKey, b.myKey].sort().join("|");
    if (open) this.closed.delete(key); else this.closed.add(key);
  }
  async settle(): Promise<void> { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
  texts(s: GroupSession): string[] { return this.messages.get(s.myKey)!.map(m => m.text); }
  /** The message frames `from` sent `to` since `before`. */
  handed(from: GroupSession, to: GroupSession, before: number): GroupEdgeFrame[] {
    return this.sent.slice(before).filter(f => f.from === from.myKey && f.to === to.myKey && f.frame.t === "group-msg").map(f => f.frame);
  }
}

async function admit(mesh: Mesh, admin: GroupSession): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const invite = admin.inviteFrame();
  const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state);
  await mesh.settle();
  return session;
}

async function trio() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Crew"));
  const bob = await admit(mesh, alice), dave = await admit(mesh, alice);
  await mesh.settle();
  return { mesh, alice, bob, dave };
}

/** Bob writes while Dave is away, then deletes it for everyone (his app notes it gone first, as the engine does). */
async function deletedWhileAway({ mesh, alice, bob, dave }: Awaited<ReturnType<typeof trio>>) {
  mesh.setEdge(bob, dave, false);
  mesh.setEdge(alice, dave, false);
  const id = ((await bob.sendText("away secret")) as { id: string }).id;
  await mesh.settle();
  expect(mesh.texts(alice)).toEqual(["away secret"]);
  mesh.gone.get(bob.myKey)!.add(id);
  await bob.sendEdit(id, { v: 5_001, ts: 9, text: REMOVED_TEXT, remove: true });
  await bob.sendText("after");
  await mesh.settle();
  return id;
}

describe("a message deleted for everyone while a member was away (WISP 400 § Delete for everyone)", () => {
  it("is not in its author's catch-up answer: the member back gets what came after, never the deleted text", async () => {
    const t = await trio();
    const { mesh, bob, dave } = t;
    await deletedWhileAway(t);
    // Dave's edge to Bob opens and his sync comes first, before any removal Bob's app has waiting.
    mesh.setEdge(bob, dave, true);
    const before = mesh.sent.length;
    await bob.handle(dave.myKey, clone(dave.syncFrame()));
    await mesh.settle();
    expect(mesh.texts(dave)).toEqual(["after"]);
    expect(mesh.handed(bob, dave, before)).toHaveLength(1);
  });

  it("is not handed on by another member, who had it before the removal, to one asking for its author", async () => {
    const t = await trio();
    const { mesh, alice, bob, dave } = t;
    await deletedWhileAway(t);
    // Alice took the removal (her app noted it gone); Dave's edge to Bob stays down and he asks Alice for Bob.
    expect(mesh.gone.get(alice.myKey)!.size).toBe(1);
    mesh.setEdge(alice, dave, true);
    await alice.handle(dave.myKey, clone(dave.syncFrame([bob.myKey])));
    await mesh.settle();
    expect(mesh.texts(dave)).toEqual(["after"]);
  });

  it("is not passed on by a hub whose app took the removal before the message", async () => {
    const t = await trio();
    const { mesh, alice, bob, dave } = t;
    await deletedWhileAway(t);
    const frame = mesh.sent.find(f => f.from === bob.myKey && f.to === alice.myKey && f.frame.t === "group-msg")!.frame;
    // Dave took the removal first (from Alice's hand-on of Bob's edits), then the message comes late.
    const id = [...mesh.gone.get(alice.myKey)!][0];
    mesh.gone.get(dave.myKey)!.add(id);
    // A hub passes on nothing of it, and no app shows it.
    expect(await dave.handle(alice.myKey, clone(frame))).toEqual([]);
    expect(mesh.texts(dave)).toEqual([]);
  });
});
