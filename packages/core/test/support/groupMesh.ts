import { createIdentity, identityFromSeedB64 } from "../../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupState } from "../../src/groupSession";
import type { GroupIncomingEdit } from "../../src/groupEdits";

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Members wired through in-memory edges that can be closed, as a member going offline closes them. */
export class Mesh {
  readonly sessions = new Map<string, GroupSession>();
  readonly inbox = new Map<string, GroupIncomingMessage[]>();
  readonly edits = new Map<string, GroupIncomingEdit[]>();
  readonly saved = new Map<string, GroupState>();
  readonly sentFrames: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  readonly changes = new Map<string, number>();
  /** The sessions' clock (`hooks.clock`) when set; the wall clock otherwise. */
  clock: number | null = null;
  private closed = new Set<string>();
  private pending: Promise<unknown>[] = [];
  private edge(a: string, b: string): string { return [a, b].sort().join("|"); }
  setEdge(a: string, b: string, open: boolean): void { if (open) this.closed.delete(this.edge(a, b)); else this.closed.add(this.edge(a, b)); }
  isOpen(a: string, b: string): boolean { return !this.closed.has(this.edge(a, b)); }
  add(state: GroupState, name?: string): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async s => { this.saved.set(session.myKey, s); },
      clock: () => this.clock ?? Date.now(),
      send: (to, frame) => {
        this.sentFrames.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (!target || !this.isOpen(session.myKey, to)) return false;
        this.pending.push(target.handle(session.myKey, clone(frame)));
        return true;
      },
      message: m => { this.inbox.get(session.myKey)!.push(m); },
      edit: e => { this.edits.get(session.myKey)!.push(e); },
      changed: () => this.changes.set(session.myKey, (this.changes.get(session.myKey) ?? 0) + 1),
    });
    this.sessions.set(session.myKey, session);
    this.inbox.set(session.myKey, []);
    this.edits.set(session.myKey, []);
    if (name) void session.setNick(session.myKey, name);
    return session;
  }
  /** Both sides of an edge that just opened introduce themselves; `ask`: the members each side asks the other to hand on. */
  async open(a: GroupSession, b: GroupSession, ask: { a?: string[]; b?: string[] } = {}): Promise<void> {
    this.setEdge(a.myKey, b.myKey, true);
    this.pending.push(b.handle(a.myKey, clone(a.syncFrame(ask.a))), a.handle(b.myKey, clone(b.syncFrame(ask.b))));
    await this.settle();
  }
  async settle(): Promise<void> {
    while (this.pending.length) { const batch = this.pending.splice(0); await Promise.all(batch); }
  }
  texts(session: GroupSession): string[] { return this.inbox.get(session.myKey)!.map(m => m.text); }
}

/** Admits `member` into `admin`'s group and opens its edges to everyone already in. */
export async function admit(mesh: Mesh, admin: GroupSession, name: string, invite = admin.inviteFrame()): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const key = identityFromSeedB64(seed).pubKeyZ32;
  const welcome = await admin.admit(key);
  const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = mesh.add(joined.state, name);
  await mesh.settle();
  for (const other of session.others) { const peer = mesh.sessions.get(other); if (peer) await mesh.open(session, peer); }
  return session;
}
