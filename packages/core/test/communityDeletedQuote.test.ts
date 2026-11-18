import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunityMessageFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
import { decryptText, epochKeys } from "../src/groupCrypto";
import { fromBase64Url } from "../src/bytes";
// covers: groups.protocol.replies, groups.community.send

/*
 * A reply seals a line of the message it answers (`r.s`). Once that message is deleted for everyone, no frame this
 * profile keeps (its record's store, or a row's frame) opens to that line any more: the reply author's own frame is
 * sealed again without it, a member's is let go.
 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SECRET = "the vault code is 4711";

/** Every text any kept frame opens to, with every epoch secret the state keeps. */
function readable(state: CommunityState, rows: Iterable<CommunityMessageFrame> = []): string[] {
  const out: string[] = [];
  for (const f of [...state.store, ...rows]) {
    for (const secret of Object.values(state.secrets)) {
      const plain = decryptText(epochKeys(fromBase64Url(secret), f.g, f.e).message, JSON.stringify([f.g, f.e, f.h, f.s, f.n, f.ts]), f.nn, f.c);
      if (plain !== null) out.push(plain);
    }
  }
  return out;
}

async function pair() {
  const toBob: CommunityFrame[] = [], toAlice: CommunityFrame[] = [];
  let bobKey = "";
  const aliceSaved: CommunityState[] = [];
  const aliceGot: CommunityIncomingMessage[] = [];
  const alice = new CommunitySession(CommunitySession.create("Ghosts"), {
    changed: () => {}, save: async s => { aliceSaved.push(clone(s)); },
    // A member's reply kept in the record only, as a profile from before rows held frames.
    message: m => { aliceGot.push(m); return false; },
    broadcast: frame => { toBob.push(clone(frame)); return 1; },
    direct: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); return true; },
    addressed: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); },
  });
  const seed = createIdentity().seedB64;
  bobKey = identityFromSeedB64(seed).pubKeyZ32;
  const frames = await alice.admit(bobKey);
  const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seed);
  if ("error" in joined) throw new Error(joined.error);
  const bobSaved: CommunityState[] = [];
  const rows = new Map<string, CommunityMessageFrame>();
  const forgotten: string[] = [];
  const bobHooks: CommunitySessionHooks = {
    changed: () => {}, save: async s => { bobSaved.push(clone(s)); },
    message: m => { if (!m.frame) return false; rows.set(m.id, clone(m.frame)); return true; },
    forgetFrame: id => { forgotten.push(id); rows.delete(id); },
    broadcast: frame => { toAlice.push(clone(frame)); return 1; },
    direct: (_to, frame) => { toAlice.push(clone(frame)); return true; },
    addressed: () => {},
  };
  const bob = new CommunitySession(joined.state, bobHooks);
  toBob.length = 0;
  const said = await alice.sendText(SECRET, "Alice");
  if ("error" in said) throw new Error(said.error);
  for (const f of toBob.splice(0)) await bob.handle(alice.myKey, f);
  const aliceBefore = clone(alice.state);
  const reply = await bob.sendText("noted", "Bob", Date.now(), [], { i: said.id, s: SECRET, f: alice.myKey });
  if ("error" in reply) throw new Error(reply.error);
  const replyFrame = toAlice.find((f): f is CommunityMessageFrame => f.t === "group-msg")!;
  await alice.handle(bob.myKey, clone(replyFrame));
  return { alice, aliceSaved, aliceGot, aliceBefore, bob, bobHooks, bobSaved, rows, forgotten, deleted: said.id, reply: reply.id, replyFrame };
}

describe("a reply to a message deleted for everyone, in a community", () => {
  it("is sealed again without the line by its author, in the same place, and goes from the row that held the first", async () => {
    const { bob, bobSaved, rows, forgotten, deleted, reply, replyFrame } = await pair();
    expect(readable(bob.state, rows.values()).some(t => t.includes(SECRET))).toBe(true);
    // The app drops the deleted message's row (`Groups.removed`), then the session lets go of what quotes it.
    rows.delete(deleted);
    bob.forget(deleted);
    await bob.flush();
    expect(forgotten).toContain(reply);
    expect(readable(bobSaved.at(-1)!, rows.values()).filter(t => t.includes(SECRET))).toEqual([]);
    expect(readable(bob.state).filter(t => t.includes(SECRET))).toEqual([]);
    const again = bob.state.store.find(f => f.s === bob.myKey && f.n === replyFrame.n)!;
    expect({ ...again, nn: "", c: "", sig: "" }).toEqual({ ...replyFrame, nn: "", c: "", sig: "" });
    expect(again.sig).not.toBe(replyFrame.sig);
    // It is still the reply, to the same message, its text kept.
    const opened = readable(bob.state).map(t => JSON.parse(t) as { text: string; r?: { i: string; s: string } }).find(p => p.text === "noted")!;
    expect(opened.r).toMatchObject({ i: deleted, s: "" });
  });

  it("a member who missed the reply takes the one sealed again: signed, the reply kept, without the line", async () => {
    const { alice, aliceBefore, bob, deleted, reply, replyFrame } = await pair();
    bob.forget(deleted);
    const again = clone(bob.state.store.find(f => f.s === bob.myKey && f.n === replyFrame.n)!);
    const got: CommunityIncomingMessage[] = [];
    const late = new CommunitySession(clone(aliceBefore), { changed: () => {}, save: async () => {}, message: m => { got.push(m); }, broadcast: () => 1, direct: () => true, addressed: () => {} });
    expect(await late.handle(bob.myKey, again)).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: reply, text: "noted", reply: { i: deleted, s: "" } });
    // One who holds the first drops it as seen.
    expect(await alice.handle(bob.myKey, clone(again))).toBe(false);
  });

  it("a member's reply kept in the record goes from it", async () => {
    const { alice, aliceSaved, aliceGot, bob, deleted } = await pair();
    expect(aliceGot.some(m => m.sender === bob.myKey && m.reply?.s === SECRET)).toBe(true);
    alice.forget(deleted);
    await alice.flush();
    expect(readable(alice.state).filter(t => t.includes(SECRET))).toEqual([]);
    expect(readable(aliceSaved.at(-1)!).filter(t => t.includes(SECRET))).toEqual([]);
  });

  it("deleted before this device let it go, it goes when the session starts", async () => {
    const { bob, bobHooks, bobSaved, rows, deleted } = await pair();
    rows.delete(deleted);
    await bob.flush();
    // A record from before rows held frames: the reply in its store, and no row.
    const state = clone(bobSaved.at(-1)!);
    state.store = [...state.store, ...clone([...rows.values()])];
    const saved: CommunityState[] = [];
    const next = new CommunitySession(state, { ...bobHooks, save: async s => { saved.push(clone(s)); }, removed: id => id === deleted });
    await next.flush();
    expect(readable(next.state).filter(t => t.includes(SECRET))).toEqual([]);
    expect(readable(saved.at(-1)!).filter(t => t.includes(SECRET))).toEqual([]);
    expect(readable(next.state).some(t => t.includes("noted"))).toBe(true);
  });

  it("a row still holding the first after a stop gives it up to the one sealed again", async () => {
    const { bob, bobHooks, bobSaved, rows, deleted, reply } = await pair();
    rows.delete(deleted);
    const first = clone([...rows]);
    bob.forget(deleted);
    await bob.flush();
    // The app stopped before the row let its frame go: the row holds the first, the record the one sealed again.
    const forgotten: string[] = [];
    const next = new CommunitySession(clone(bobSaved.at(-1)!), { ...bobHooks, forgetFrame: id => { forgotten.push(id); } }, first.map(([id, frame]) => ({ id, frame })));
    expect(forgotten).toContain(reply);
    expect(readable(next.state).filter(t => t.includes(SECRET))).toEqual([]);
  });
});
