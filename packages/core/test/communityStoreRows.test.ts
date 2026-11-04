import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { COMMUNITY_LIMITS, CommunitySession, type CommunityFrame, type CommunityMessageFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.catch-up

/*
 * What a community's session keeps to hand on stays whole in memory; what it saves leaves out the frames an
 * app holds with its messages (`rows`), which come back when it starts again.
 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const quiet: Omit<CommunitySessionHooks, "save" | "message"> = { changed: () => {}, broadcast: () => 1, direct: () => true, addressed: () => {} };

function author() {
  const saved: CommunityState[] = [];
  const rows = new Map<string, CommunityMessageFrame>();
  const forgotten: string[] = [];
  const hooks: CommunitySessionHooks = {
    ...quiet,
    save: async state => { saved.push(state); },
    message: m => { if (!m.frame) return false; rows.set(m.id, m.frame); return true; },
    forgetFrame: id => { forgotten.push(id); rows.delete(id); },
  };
  return { session: new CommunitySession(CommunitySession.create("Ghosts"), hooks), hooks, saved, rows, forgotten };
}
const held = (rows: Map<string, CommunityMessageFrame>) => [...rows].map(([id, frame]) => ({ id, frame: clone(frame) }));

describe("a community's frames kept on rows", () => {
  it("are left out of what is saved, and stay in what it hands on", async () => {
    const { session, saved, rows } = author();
    for (let i = 0; i < 3; i++) await session.sendText(`line ${i}`, "Alice");
    expect(rows.size).toBe(3);
    await session.flush();
    expect(saved.at(-1)!.store).toEqual([]);
    expect(session.state.store).toHaveLength(3);
  });

  it("a frame no row took is saved as before", async () => {
    const saved: CommunityState[] = [];
    const session = new CommunitySession(CommunitySession.create("Ghosts"), { ...quiet, save: async state => { saved.push(state); }, message: () => {} });
    await session.sendText("no row", "Alice");
    await session.flush();
    expect(saved.at(-1)!.store).toHaveLength(1);
  });

  it("come back after a start, with a record from before taken as it is, in the order they were written", async () => {
    const first = author();
    for (let i = 0; i < 3; i++) await first.session.sendText(`line ${i}`, "Alice", 1_000 + i);
    await first.session.flush();
    const state = clone(first.saved.at(-1)!);
    const [oldest, ...newer] = held(first.rows);
    // A record saved before: it still holds the oldest of them, and no row does.
    state.store = [oldest.frame];
    const next = new CommunitySession(state, { ...first.hooks, save: async () => {} }, newer);
    expect(next.state.store.map(f => f.n)).toEqual([0, 1, 2]);
  });

  it("taken again after a save that was lost, are kept once", async () => {
    const hub = author();
    const toBob: CommunityFrame[] = [];
    let bobKey = "";
    const alice = new CommunitySession(CommunitySession.create("Ghosts"), {
      ...quiet, save: async () => {}, message: () => {},
      broadcast: frame => { toBob.push(clone(frame)); return 1; },
      direct: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); return true; },
      addressed: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); },
    });
    const seed = createIdentity().seedB64;
    bobKey = identityFromSeedB64(seed).pubKeyZ32;
    const frames = await alice.admit(bobKey);
    const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    toBob.length = 0;
    await alice.sendText("once", "Alice");
    const said = toBob.find(f => f.t === "group-msg")!;
    const start = clone(joined.state);
    const rows = new Map<string, CommunityMessageFrame>();
    const bob = new CommunitySession(clone(start), { ...hub.hooks, save: async () => {}, message: m => { rows.set(m.id, m.frame!); return true; } });
    await bob.handle(alice.myKey, clone(said));
    expect(bob.state.store).toHaveLength(1);
    // The app stopped before its save: the row has the frame, the state does not know it was seen.
    const again = new CommunitySession(clone(start), { ...hub.hooks, save: async () => {}, message: () => false }, held(rows));
    await again.handle(alice.myKey, clone(said));
    expect(again.state.store).toHaveLength(1);
  });

  it("past the store, the oldest row gives its frame up", async () => {
    const { session, rows, forgotten } = author();
    for (let i = 0; i < COMMUNITY_LIMITS.store + 2; i++) await session.sendText(`line ${i}`, "Alice");
    expect(rows.size).toBe(COMMUNITY_LIMITS.store);
    expect(forgotten).toHaveLength(2);
    expect(forgotten[0].endsWith(":0")).toBe(true);
  });

  it("a member no longer in gives them up, and holds none after a start", async () => {
    const toBob: CommunityFrame[] = [];
    let bobKey = "";
    const alice = new CommunitySession(CommunitySession.create("Ghosts"), {
      ...quiet, save: async () => {}, message: () => {},
      broadcast: frame => { toBob.push(clone(frame)); return 1; },
      direct: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); return true; },
      addressed: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); },
    });
    const seed = createIdentity().seedB64;
    bobKey = identityFromSeedB64(seed).pubKeyZ32;
    const frames = await alice.admit(bobKey);
    const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    toBob.length = 0;
    const rows = new Map<string, CommunityMessageFrame>();
    const forgotten: string[] = [];
    const saved: CommunityState[] = [];
    const hooks: CommunitySessionHooks = { ...quiet, save: async s => { saved.push(s); }, message: m => { rows.set(m.id, m.frame!); return true; }, forgetFrame: id => { forgotten.push(id); rows.delete(id); } };
    const bob = new CommunitySession(clone(joined.state), hooks);
    await alice.sendText("before", "Alice");
    for (const frame of toBob.splice(0)) await bob.handle(alice.myKey, frame);
    expect(rows.size).toBe(1);
    const leftRows = held(rows);
    await alice.remove(bobKey);
    for (const frame of toBob.splice(0)) await bob.handle(alice.myKey, frame);
    expect(bob.isMember).toBe(false);
    expect(rows.size).toBe(0);
    expect(forgotten).toHaveLength(1);
    // A row that kept its frame through a stop: nothing of it is taken in.
    await bob.flush();
    const back = new CommunitySession(clone(saved.at(-1)!), hooks, leftRows);
    expect(back.state.store).toEqual([]);
    expect(forgotten).toHaveLength(2);
  });
});
