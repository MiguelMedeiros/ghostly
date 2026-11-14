import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunityMessageFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.catch-up

/*
 * A community member's app killed while it sends a text (kill -9, out of memory, a tab closed): what it saved and
 * stored up to that point is all it has when it opens again. Its counter was saved only after the text's row was
 * stored, so an app killed in between gave its next text the same id: the members who were up held the next text
 * under it and those who caught up later the first, or, synced first, every member dropped the next text as one
 * already seen. Now the counter and the frame are saved first, as a private group's are.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** What Alice's app keeps on disk: her saved state, and her rows (one per id, as the app's store keeps them, with the frame). */
interface Disk { state: CommunityState; rows: Map<string, { text: string; frame?: CommunityMessageFrame }> }

/**
 * Where Alice's app is killed: in the hook call numbered `step` (1 is the first, saves and stored rows alike), before or
 * after it did its work; or right after the row of the text `afterRowOf` is stored.
 */
interface Kill { step?: number; after?: boolean; afterRowOf?: string }

interface Member { name: string; session: CommunitySession; online: boolean; rows: Map<string, string[]> }

/** Members on one network, each frame in order and a moment apart. */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];
  private queues = new Map<string, Promise<unknown>>();

  deliver(from: Member, to: Member | undefined, frame: CommunityFrame): boolean {
    if (!to || !to.online || !from.online || to === from) return false;
    const done = (this.queues.get(to.name) ?? Promise.resolve()).then(() => sleep(1)).then(() => to.session.handle(from.session.myKey, clone(frame)));
    this.queues.set(to.name, done);
    this.pending.push(done);
    return true;
  }
  hooks(name: string): CommunitySessionHooks {
    const me = () => this.members.get(name)!;
    return {
      save: async () => {},
      broadcast: frame => [...this.members.values()].filter(m => this.deliver(me(), m, frame)).length,
      direct: (to, frame) => this.deliver(me(), this.byKey(to), frame),
      addressed: (to, frame) => { this.deliver(me(), this.byKey(to), frame); },
      // Each row its own id, as the app's store keeps them: a second text under one id is held beside the first, to tell.
      message: m => { const held = me().rows.get(m.id); me().rows.set(m.id, [...held ?? [], m.text]); return false; },
      changed: () => {},
      handled: async to => { await this.queues.get(this.byKey(to)?.name ?? ""); return true; },
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  add(name: string, state: CommunityState, hooks = this.hooks(name), rows?: { id: string; frame: CommunityMessageFrame }[]): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, rows: new Map() };
    this.members.set(name, member);
    member.session = new CommunitySession(state, hooks, rows);
    return member;
  }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  /** `a` and `b`'s edge comes up: each says where it is (the engine's `edgeReady`). */
  async sync(a: Member, b: Member): Promise<void> {
    this.deliver(a, b, a.session.syncFrame(b.session.myKey));
    this.deliver(b, a, b.session.syncFrame(a.session.myKey));
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) { const batch = this.pending.splice(0); if (!batch.length) { await sleep(5); if (!this.pending.length) break; } await Promise.all(batch); }
  }
}

/** Alice, the admin, with Bob, Carol and Dave; Dave's app is closed from here on. */
async function community() {
  const net = new Net();
  const disk = { rows: new Map() } as Disk;
  const created = CommunitySession.create("Ghosts");
  const alice = net.add("Alice", created, { ...net.hooks("Alice"), save: async s => { disk.state = clone(s); } });
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  const dave = await net.admit(alice, "Dave");
  await net.settle();
  await alice.session.flush();
  dave.online = false;
  return { net, disk, key: alice.session.myKey, bob, carol, dave };
}

/** Alice's app opened from her disk; `kill`: the hook call that kills it. Nothing it does after that reaches anyone. */
function open(net: Net, disk: Disk, kill?: Kill) {
  let step = 0, dead = false;
  const hook = <T>(work: () => T, text?: string): T => {
    if (dead) throw new Error("killed");
    step++;
    if (kill && step === kill.step && !kill.after) { dead = true; throw new Error("killed"); }
    const done = work();
    if (kill && ((step === kill.step && kill.after) || (text !== undefined && text === kill.afterRowOf))) { dead = true; throw new Error("killed"); }
    return done;
  };
  const base = net.hooks("Alice");
  const rows = [...disk.rows].filter(([, row]) => row.frame).map(([id, row]) => ({ id, frame: clone(row.frame!) }));
  const alice = net.add("Alice", clone(disk.state), {
    ...base,
    // A save the app's timer starts after it was killed does nothing.
    save: async s => { if (dead) return; hook(() => { disk.state = clone(s); }); },
    message: m => hook(() => {
      if (disk.rows.has(m.id)) return false;
      disk.rows.set(m.id, { text: m.text, ...(m.frame && { frame: clone(m.frame) }) });
      return true;
    }, m.text),
    broadcast: frame => dead ? 0 : base.broadcast(frame),
    direct: (to, frame) => !dead && base.direct(to, frame),
    addressed: (to, frame) => { if (!dead) base.addressed(to, frame); },
  }, rows);
  return { alice, get dead() { return dead; }, kill: () => { dead = true; alice.online = false; } };
}

/** Alice's app killed (`kill`) while it sends `texts` one after another. */
async function burst(net: Net, disk: Disk, texts: string[], kill: Kill) {
  const app = open(net, disk, kill);
  for (const text of texts) {
    if (app.dead) break;
    await app.alice.session.sendText(text, "Alice").catch(() => undefined);
    await net.settle();
  }
  // Killed now if not before: its timers write nothing more.
  app.kill();
}

/** Alice's app opened again; `syncFirst`: its edges come up (each side's sync) before it sends `probe`, else after. */
async function reopen(net: Net, disk: Disk, probe: string, syncFirst: boolean) {
  const app = open(net, disk);
  const up = async () => { for (const m of net.members.values()) if (m.name !== "Alice" && m.online) await net.sync(app.alice, m); };
  if (syncFirst) await up();
  const sent = await app.alice.session.sendText(probe, "Alice");
  if (!("id" in sent)) throw new Error(sent.error);
  await net.settle();
  if (!syncFirst) await up();
  return { app, probeId: sent.id };
}

/** Everything the sender and the members hold agrees: one text per id, and each text the sender shows reached each member once. */
function expectAgreement(disk: Disk, author: string, members: Member[]) {
  const mine = [...disk.rows].filter(([id]) => id.startsWith(`${author}:`));
  for (const member of members) {
    const held = new Map([...member.rows].filter(([id]) => id.startsWith(`${author}:`)));
    for (const [id, texts] of held) expect({ who: member.name, id, texts }).toEqual({ who: member.name, id, texts: [disk.rows.get(id)?.text] });
    for (const [id, { text }] of mine) expect({ who: member.name, id, held: held.get(id) }).toEqual({ who: member.name, id, held: [text] });
  }
}

describe("a community's text when the sender's app is killed mid-send", { timeout: 120_000 }, () => {
  for (const syncFirst of [false, true]) {
    it(`killed after the text's row is stored: the next text gets a new id, and every member holds both (${syncFirst ? "synced before" : "synced after"} the next)`, async () => {
      const { net, disk, key, bob, carol, dave } = await community();
      await burst(net, disk, ["hello", "first"], { afterRowOf: "first" });
      const killed = [...disk.rows].find(([, row]) => row.text === "first");
      expect(killed).toBeDefined();
      const { probeId } = await reopen(net, disk, "second", syncFirst);
      // The bug: the next text got the interrupted one's id.
      expect(probeId).not.toBe(killed![0]);
      expect(disk.rows.get(probeId)?.text).toBe("second");
      // Dave, away throughout, catches up from Alice.
      dave.online = true;
      await net.sync(net.members.get("Alice")!, dave);
      expectAgreement(disk, key, [bob, carol, dave]);
    });
  }

  it("killed at any point of a burst: sender and members never hold two texts under one id, and nothing shown as sent is lost", async () => {
    for (let step = 1; step <= 6; step++) {
      for (const [after, syncFirst] of [[false, false], [false, true], [true, false], [true, true]]) {
        const { net, disk, key, bob, carol, dave } = await community();
        await burst(net, disk, ["a", "b", "c"], { step, after });
        const { probeId } = await reopen(net, disk, "probe", syncFirst);
        expect({ step, after, syncFirst, probe: disk.rows.get(probeId)?.text }).toEqual({ step, after, syncFirst, probe: "probe" });
        dave.online = true;
        await net.sync(net.members.get("Alice")!, dave);
        expectAgreement(disk, key, [bob, carol, dave]);
      }
    }
  });

  it("killed after its counter and frame were saved: opened again, the text is stored and said on the next tick, with no send", async () => {
    const { net, disk, key, bob, carol } = await community();
    // The kill: right after the first save of the send (on dev, its row came first, so this is after the row).
    await burst(net, disk, ["one"], { step: 1, after: true });
    const app = open(net, disk);
    await app.alice.session.resume();
    await net.settle();
    expect([...disk.rows.values()].map(r => r.text)).toEqual(["one"]);
    expectAgreement(disk, key, [bob, carol]);
  });

  it("a row an older app left behind (its counter never saved): the next text still gets a number above it", async () => {
    const { net, disk, key, bob, carol } = await community();
    const app = open(net, disk);
    expect(await app.alice.session.sendText("one", "Alice")).toHaveProperty("id");
    await net.settle();
    // An older app killed after storing the row of number 1 but before saving its counter: the state says 1 is next.
    const before = clone(disk.state);
    expect(await app.alice.session.sendText("residue", "Alice")).toHaveProperty("id");
    await net.settle();
    app.kill();
    disk.state = before;
    delete disk.state.unsaid;
    const { probeId } = await reopen(net, disk, "probe", false);
    expect(disk.rows.get(probeId)?.text).toBe("probe");
    expect([...disk.rows.values()].map(r => r.text)).toEqual(["one", "residue", "probe"]);
    expectAgreement(disk, key, [bob, carol]);
  });

  it("a row whose store fails: not sent, never said later, and the next text goes as usual", async () => {
    const { net, disk, key, bob } = await community();
    let fail = true;
    const base = net.hooks("Alice");
    const alice = net.add("Alice", clone(disk.state), {
      ...base,
      save: async s => { disk.state = clone(s); },
      message: m => { if (fail) throw new Error("disk full"); disk.rows.set(m.id, { text: m.text }); return false; },
    });
    await expect(alice.session.sendText("lost", "Alice")).rejects.toThrow("disk full");
    fail = false;
    const sent = await alice.session.sendText("next", "Alice");
    await net.settle();
    await alice.session.flush();
    expect(sent).toHaveProperty("id");
    expect(disk.state.unsaid ?? []).toEqual([]);
    await net.sync(alice, bob);
    expectAgreement(disk, key, [bob]);
    expect([...bob.rows.values()].flat()).not.toContain("lost");
  });
});
