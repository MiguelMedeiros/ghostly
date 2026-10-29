import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { identityFromSeed } from "../src/identity";
import { fromBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import {
  emptyRatchetState, FOLLOW_MS, isRatcheted, RatchetBox, MAX_SKIP, MAX_SKIPPED_KEYS, RATCHET_HEADER_BYTES, RATCHET_KEEP_MS, RATCHET_OVERHEAD, ratchetHeard, ratchetOn, ratchetOpen, ratchetRoot, ratchetSeal,
  type RatchetKeys, type RatchetLane, type RatchetState,
} from "../src/ratchet";

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const fill = (byte: number, n = 32) => new Uint8Array(n).fill(byte);
/** Deterministic "random" bytes for the vectors: SHA-256 of a label and a counter. */
function counter(tag: string) {
  let i = 0;
  return (n: number) => sha256(utf8Encode(`${tag}:${i++}`)).slice(0, n);
}

const seedA = fill(1), seedB = fill(2);
const idA = identityFromSeed(seedA), idB = identityFromSeed(seedB);
const rendezvous: [string, string] = [identityFromSeed(fill(3)).pubKeyZ32, identityFromSeed(fill(4)).pubKeyZ32];
const secret = fill(5);
const keysOf = (seed: Uint8Array, self: string, peer: string): RatchetKeys => ({ seed, self, peer, rendezvous, secret });
const ka = keysOf(seedA, idA.pubKeyZ32, idB.pubKeyZ32), kb = keysOf(seedB, idB.pubKeyZ32, idA.pubKeyZ32);
// Which of the two sorts first decides the roles; the tests name them by role.
const aFirst = (() => { const a = idA.publicKey, b = idB.publicKey; for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; })();
const first = aFirst ? ka : kb, second = aFirst ? kb : ka;

const compare = (a: string, b: string) => { const x = fromBase64Url(a), y = fromBase64Url(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
/** The floor sequence each sealed envelope went with (WISP 403's, which a restore raises past what was used). */
const sequences = new WeakMap<Uint8Array, number>();
class Side {
  state: RatchetState = emptyRatchetState();
  constructor(readonly keys: RatchetKeys, readonly random?: (n: number) => Uint8Array, private sequence = 0) {}
  seal(text: string, lane: RatchetLane = "floor", now = 1_000) {
    const { state, sealed } = ratchetSeal(this.state, this.keys, lane, utf8Encode(text), { now, random: this.random });
    this.state = state;
    if (lane === "floor") sequences.set(sealed, ++this.sequence);
    return sealed;
  }
  open(sealed: Uint8Array, lane: RatchetLane = "floor", now = 1_000) {
    const opened = ratchetOpen(this.state, this.keys, lane, sealed, { now, random: this.random });
    if (!opened) return null;
    this.state = opened.finish(sequences.get(sealed));
    return utf8Decode(opened.plaintext);
  }
}

describe("ratchet/1", () => {
  it("adds a fixed overhead and says what it sealed", () => {
    const one = new Side(first);
    const sealed = one.seal("hello");
    expect(sealed.length).toBe(RATCHET_OVERHEAD + 5);
    expect(RATCHET_HEADER_BYTES).toBe(50);
    expect(isRatcheted(sealed, "floor")).toBe(true);
    expect(isRatcheted(sealed, "hold")).toBe(false);
  });

  it("opens both ways, whichever side speaks first, and is on once the turn passed both ways", () => {
    for (const starter of ["first", "second"] as const) {
      const f = new Side(first), s = new Side(second);
      const [x, y] = starter === "first" ? [f, s] : [s, f];
      expect(y.open(x.seal("one"))).toBe("one");
      expect(ratchetHeard(y.state, "floor")).toBe(true);
      expect(x.open(y.seal("two"))).toBe("two");
      expect(y.open(x.seal("three"))).toBe("three");
      expect(x.open(y.seal("four"))).toBe("four");
      expect(y.open(x.seal("five"))).toBe("five");
      expect(ratchetOn(x.state) && ratchetOn(y.state)).toBe(true);
      expect(y.state.current?.sid).toBe(x.state.current?.sid);
    }
  });

  it("is off while what goes is still on a session's first chains, which the participation keys open", () => {
    const f = new Side(first), s = new Side(second);
    const one = f.seal("first chain");
    expect(s.open(one)).toBe("first chain");
    expect(ratchetOn(s.state)).toBe(false);
    // Who holds the second side's participation key (and the invite) opens it, with nothing else: the WISP says so.
    expect(ratchetOpen(emptyRatchetState(), second, "floor", one)).not.toBeNull();
    expect(f.open(s.seal("reply"))).toBe("reply");
    expect(ratchetOn(f.state)).toBe(true);
    const after = f.seal("after the turn");
    expect(s.open(after)).toBe("after the turn");
    expect(ratchetOn(s.state)).toBe(true);
    expect(ratchetOpen(emptyRatchetState(), second, "floor", after)).toBeNull();
  });

  it("uses a new key each time the turn passes, and a key once", () => {
    const f = new Side(first), s = new Side(second);
    const m1 = f.seal("a");
    expect(s.open(m1)).toBe("a");
    expect(s.open(m1)).toBeNull();
    const before = s.state.current!.dhsPub;
    expect(f.open(s.seal("b"))).toBe("b");
    expect(s.open(f.seal("c"))).toBe("c");
    s.seal("d");
    expect(s.state.current!.dhsPub).not.toBe(before);
  });

  it("refuses what is changed, reflected, or on the other lane", () => {
    const f = new Side(first), s = new Side(second);
    const sealed = f.seal("secret");
    for (const at of [0, 1, 5, 20, 45, sealed.length - 1]) {
      const bent = sealed.slice(); bent[at] ^= 1;
      expect(ratchetOpen(s.state, s.keys, "floor", bent)).toBeNull();
    }
    expect(ratchetOpen(f.state, f.keys, "floor", sealed)).toBeNull();
    expect(ratchetOpen(s.state, s.keys, "hold", sealed)).toBeNull();
    expect(s.open(sealed)).toBe("secret");
  });

  it("on the floor, steps over what was replaced unread, never back, and not past its bound", () => {
    const f = new Side(first), s = new Side(second);
    const all = Array.from({ length: 5 }, (_, i) => f.seal(`m${i}`));
    expect(s.open(all[3])).toBe("m3");
    expect(s.open(all[1])).toBeNull();
    expect(s.open(all[4])).toBe("m4");
    expect(s.state.skipped).toHaveLength(0);
    // A number past the bound is refused before any step (a sender never seals one: see the next test).
    const forged = f.seal("m5");
    for (const n of [s.state.current!.recv!.floor.n + MAX_SKIP.floor + 1, 0xffffffff]) {
      const far = forged.slice(); new DataView(far.buffer).setUint32(RATCHET_HEADER_BYTES - 4, n);
      const started = performance.now();
      expect(s.open(far)).toBeNull();
      expect(performance.now() - started).toBeLessThan(200);
    }
    expect(s.open(forged)).toBe("m5");
  });

  it("starts a new session rather than seal past the bound, so a contact away for long still reads it", () => {
    for (const lane of ["floor", "hold"] as const) {
      const f = new Side(first), s = new Side(second);
      expect(s.open(f.seal("hello"))).toBe("hello");
      const sid = f.state.current!.sid;
      let last: Uint8Array = new Uint8Array();
      for (let i = 0; i <= MAX_SKIP[lane]; i++) last = f.seal("x", lane);
      expect(f.state.current!.sid).not.toBe(sid);
      if (lane === "hold") expect(s.open(f.seal("floor"))).toBe("floor");
      expect(s.open(last, lane)).toBe("x");
      expect(f.open(s.seal("back"))).toBe("back");
    }
  });

  it("takes a contact's key that gives no secret as an item that does not open", () => {
    const f = new Side(first), s = new Side(second);
    const sealed = f.seal("x");
    const zero = sealed.slice(); zero.fill(0, 10, 42);
    expect(() => ratchetOpen(s.state, s.keys, "floor", zero)).not.toThrow();
    expect(ratchetOpen(s.state, s.keys, "floor", zero)).toBeNull();
  });

  it("opens held items in any order, from an old chain too, and each once", () => {
    const f = new Side(first), s = new Side(second);
    const held = Array.from({ length: 5 }, (_, i) => f.seal(`h${i}`, "hold"));
    expect(s.open(held[4], "hold")).toBe("h4");
    expect(s.state.skipped).toHaveLength(4);
    // The turn passes and comes back while two items of the first chain are still out.
    expect(f.open(s.seal("ack", "floor"))).toBe("ack");
    const late = f.seal("h5", "hold");
    expect(s.open(late, "hold")).toBe("h5");
    for (const i of [2, 0, 3, 1]) expect(s.open(held[i], "hold")).toBe(`h${i}`);
    for (const i of [0, 4]) expect(s.open(held[i], "hold")).toBeNull();
    expect(s.state.skipped).toHaveLength(0);
  });

  it("keeps held items' keys of a chain the contact left, as far as it says it went", () => {
    const f = new Side(first), s = new Side(second);
    expect(s.open(f.seal("start"))).toBe("start");
    expect(f.open(s.seal("turn"))).toBe("turn");
    const out = [f.seal("x0", "hold"), f.seal("x1", "hold")];
    expect(s.open(f.seal("floor after"))).toBe("floor after");
    expect(f.open(s.seal("turn again"))).toBe("turn again");
    // The first side stepped; its two held items of the chain before come later.
    expect(s.open(f.seal("new chain"))).toBe("new chain");
    expect(s.open(out[1], "hold")).toBe("x1");
    expect(s.open(out[0], "hold")).toBe("x0");
  });

  it("bounds the keys it keeps: per gap, in all, and in time", () => {
    const f = new Side(first), s = new Side(second);
    const forged = f.seal("too far", "hold");
    new DataView(forged.buffer).setUint32(RATCHET_HEADER_BYTES - 4, MAX_SKIP.hold + 1);
    expect(s.open(forged, "hold")).toBeNull();
    const g = new Side(first), t = new Side(second);
    const kept: Uint8Array[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < MAX_SKIP.hold - 1; i++) kept.push(g.seal("x", "hold"));
      expect(t.open(g.seal("y", "hold"), "hold")).toBe("y");
      expect(t.state.skipped.length).toBeLessThanOrEqual(MAX_SKIPPED_KEYS);
      // The turn passes, so the next round is a new chain within the bound.
      expect(g.open(t.seal("ack"))).toBe("ack");
    }
    expect(t.open(kept[0], "hold")).toBeNull();
    expect(t.open(kept[kept.length - 1], "hold")).toBe("x");
    const later = 1_000 + RATCHET_KEEP_MS;
    expect(t.open(kept[kept.length - 2], "hold", later)).toBeNull();
    expect(t.state.skipped.length).toBeLessThanOrEqual(MAX_SKIPPED_KEYS);
  });

  it("settles on one session when both start at once", () => {
    const f = new Side(first), s = new Side(second);
    const fromF = f.seal("f1"), fromS = s.seal("s1");
    expect(f.open(fromS)).toBe("s1");
    expect(s.open(fromF)).toBe("f1");
    expect(s.open(f.seal("f2"))).toBe("f2");
    expect(f.open(s.seal("s2"))).toBe("s2");
    expect(f.state.current!.sid).toBe(s.state.current!.sid);
    expect(f.open(s.seal("s3"))).toBe("s3");
    expect(s.open(f.seal("f3"))).toBe("f3");
  });

  it("never splits when a held item of a session that lost comes late", () => {
    const f = new Side(first), s = new Side(second);
    const fromF = f.seal("f1"), fromS = s.seal("s1");
    const lateF = f.seal("late held", "hold"), lateS = s.seal("late held", "hold");
    expect(f.open(fromS)).toBe("s1");
    expect(s.open(fromF)).toBe("f1");
    // Each speaks in the session that won, so each side's current one is heard; then the late items come.
    expect(s.open(f.seal("f2"))).toBe("f2");
    expect(f.open(s.seal("s2"))).toBe("s2");
    expect(s.open(lateF, "hold")).toBe("late held");
    expect(f.open(lateS, "hold")).toBe("late held");
    expect(f.state.current!.sid).toBe(s.state.current!.sid);
    expect(f.open(s.seal("s3"))).toBe("s3");
    expect(s.open(f.seal("f3"))).toBe("f3");
  });

  it("starts anew with a side that lost its state, by its newer floor sequence, and never takes a retired session back", () => {
    const f = new Side(first), s = new Side(second);
    const old = f.seal("before");
    expect(s.open(old)).toBe("before");
    expect(f.open(s.seal("reply"))).toBe("reply");
    const oldSid = s.state.current!.sid;
    // The first side restored from its seed: nothing of the ratchet came with it; its floor sequence goes on past the old.
    let base = 100;
    const restore = () => {
      const side = new Side(first, undefined, base += 100);
      expect(s.open(side.seal("after restore"))).toBe("after restore");
      expect(s.state.current!.sid).toBe(side.state.current!.sid);
      expect(side.open(s.seal("welcome back"))).toBe("welcome back");
      return side;
    };
    restore();
    // What the first side sent before the restore is still read, until it is replaced.
    expect(s.state.others.map(o => o.sid)).toContain(oldSid);
    restore(); restore();
    expect(s.state.others.map(o => o.sid)).not.toContain(oldSid);
    const fresh = new Side(second);
    fresh.state = structuredClone(s.state);
    expect(fresh.open(old)).toBeNull();
  });

  for (const stale of [1, 2, 3]) it(`does not follow ${stale} envelope(s) of a session that lost, read after both settled`, () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = new Side(first), q = new Side(second);
      const pOld = Array.from({ length: stale }, (_, i) => p.seal(`p${i}`)), qOld = Array.from({ length: stale }, (_, i) => q.seal(`q${i}`));
      const pLoses = compare(p.state.current!.sid, q.state.current!.sid) < 0;
      const [x, y, xStale, yFirst] = pLoses ? [p, q, pOld, qOld[0]] : [q, p, qOld, pOld[0]];
      expect(x.open(yFirst)).not.toBeNull();
      expect(y.open(x.seal("held in the winner", "hold"), "hold")).toBe("held in the winner");
      // The loser's mailbox (or a relay lagging behind) still shows its envelopes from before: they open, and win nothing.
      for (const envelope of xStale) expect(y.open(envelope)).not.toBeNull();
      expect(y.state.current!.sid).toBe(x.state.current!.sid);
      for (let i = 0; i < 3; i++) { expect(x.open(y.seal(`y${i}`))).toBe(`y${i}`); expect(y.open(x.seal(`x${i}`))).toBe(`x${i}`); }
      expect(x.state.current!.sid).toBe(y.state.current!.sid);
      expect(ratchetOn(x.state) && ratchetOn(y.state)).toBe(true);
      expect(new Side(y.keys).open(x.seal("late"))).toBeNull();
      // Read after the winner's floor envelopes, they are older by the contact's sequence, and win nothing either.
      for (const envelope of xStale) y.open(envelope);
      expect(y.state.current!.sid).toBe(x.state.current!.sid);
    }
  });

  it("follows a contact that lost its state just as both settled, once its own session keeps rising", () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const p = new Side(first), q = new Side(second);
      const pFirst = p.seal("p"), qFirst = q.seal("q");
      const pLoses = compare(p.state.current!.sid, q.state.current!.sid) < 0;
      const [x, y, yFirst] = pLoses ? [p, q, qFirst] : [q, p, pFirst];
      expect(x.open(yFirst)).not.toBeNull();
      expect(y.open(x.seal("held", "hold"), "hold")).toBe("held");
      // x restores before y opened any floor envelope of its in that session.
      const restored = new Side(x.keys, undefined, 1_000);
      const at = 1_000 + FOLLOW_MS + 1;
      for (let i = 0; i < 3; i++) expect(y.open(restored.seal(`r${i}`, "floor", at), "floor", at)).toBe(`r${i}`);
      expect(y.state.current!.sid).toBe(restored.state.current!.sid);
      expect(restored.open(y.seal("y", "floor", at), "floor", at)).toBe("y");
      expect(y.open(restored.seal("again", "floor", at), "floor", at)).toBe("again");
      expect(restored.open(y.seal("y again", "floor", at), "floor", at)).toBe("y again");
      expect(ratchetOn(y.state) && ratchetOn(restored.state)).toBe(true);
    }
  });

  it("derives the root from the invite, the chat and both keys", () => {
    const sid = fill(9, 8);
    expect(hex(ratchetRoot(ka, sid))).toBe(hex(ratchetRoot(kb, sid)));
    expect(hex(ratchetRoot({ ...ka, secret: fill(6) }, sid))).not.toBe(hex(ratchetRoot(ka, sid)));
    expect(hex(ratchetRoot({ ...ka, rendezvous: [rendezvous[0], identityFromSeed(fill(7)).pubKeyZ32] }, sid))).not.toBe(hex(ratchetRoot(ka, sid)));
    expect(hex(ratchetRoot(ka, fill(8, 8)))).not.toBe(hex(ratchetRoot(ka, sid)));
  });

  // The vectors of WISP 4xx-ratchet § Test vectors: an independent implementation reproduces these bytes.
  it("matches the published vectors", () => {
    const f = new Side(first, counter("first")), s = new Side(second, counter("second"));
    const v1 = f.seal("hello", "floor", 0);
    expect(s.open(v1, "floor", 0)).toBe("hello");
    const v2 = s.seal("hi", "floor", 0);
    expect(f.open(v2, "floor", 0)).toBe("hi");
    const v3 = f.seal("held", "hold", 0);
    expect(s.open(v3, "hold", 0)).toBe("held");
    const vectors = {
      firstKey: first.self, secondKey: second.self, rendezvous, root: hex(ratchetRoot(first, counter("first")(8))),
      v1: hex(v1), v2: hex(v2), v3: hex(v3),
    };
    expect(vectors).toMatchInlineSnapshot(`
      {
        "firstKey": "orhzqdiexwmi6iidktucgud63ufa5nwtsuzdxe176a8izd6jsqky",
        "rendezvous": [
          "7ir1ttte48bcp4zjychjyscicrwi1j34mtt91ptsafdbjmr8g9eo",
          "3kj4afafdba8diu5oxd96dz6orrqt5nfgbmi473go6ju8s64z36y",
        ],
        "root": "f410f63e47a1197cfa2f4ae0961b25a79fdf5d38c60b2bff7aad2b898d0708e3",
        "secondKey": "tkrq8zmwb8a3m9k15csu3q17qmfgqnp9dskbrg9uq1rydpyxp7qy",
        "v1": "0101abd1938e708c91f3ade5ec0474e27723700d837ac3ac14d08ca0cd1d6dc9d98cc6fe6a610069367e00000000000000007fb640351c34e105b2989b58044fd25f1dfbba9988",
        "v2": "0101abd1938e708c91f33d63ca075dcd63457fb9512a7df8c00c0f16f8fd65aadc011211dcbfd31e251f00000000000000009927adc92e1f54d7484543e9210d6e7e896f",
        "v3": "0102abd1938e708c91f3fe4fb690c33193e0a541b8854cdbd57820511be7a331ea87f1f663328852a54400000000000000004f6a11c22fbbb97156cfa23385a933089064b4bb",
      }
    `);
  });
});

describe("RatchetBox", () => {
  it("never starts a seal and an open from the same state, so no key is used twice", async () => {
    let savedF = emptyRatchetState(), savedS = emptyRatchetState();
    const f = new RatchetBox(() => first, savedF, async s => { savedF = s; });
    const s = new RatchetBox(() => second, savedS, async st => { savedS = st; });
    const one = await f.lock(box => box.seal("floor", utf8Encode("one")));
    expect(await s.lock(async box => { const o = box.open("floor", one)!; await o.commit(); return utf8Decode(o.plaintext); })).toBe("one");
    const reply = await s.lock(box => box.seal("floor", utf8Encode("reply")));
    // An open whose content takes a while to store, and a seal asked for meanwhile.
    let release!: () => void;
    const stored = new Promise<void>(r => { release = r; });
    const opening = f.lock(async box => { const o = box.open("floor", reply)!; await stored; await o.commit(); });
    const sealing = f.lock(box => box.seal("floor", utf8Encode("after")));
    release();
    await opening;
    const after = await sealing;
    const again = await f.lock(box => box.seal("floor", utf8Encode("again")));
    expect(hex(after.slice(0, RATCHET_HEADER_BYTES))).not.toBe(hex(again.slice(0, RATCHET_HEADER_BYTES)));
    expect(await s.lock(async box => { const o = box.open("floor", again)!; await o.commit(); return utf8Decode(o.plaintext); })).toBe("again");
    expect(savedF.current?.sid).toBe(savedS.current?.sid);
  });

  it("moves nothing on an open that is not committed, and peeks without keeping", async () => {
    let saved = emptyRatchetState();
    const f = new RatchetBox(() => first, emptyRatchetState(), async () => {});
    const s = new RatchetBox(() => second, saved, async st => { saved = st; });
    const one = await f.lock(box => box.seal("hold", utf8Encode("held")));
    expect(s.peek("hold", one)).not.toBeNull();
    await s.lock(async box => { expect(box.open("hold", one)).not.toBeNull(); });
    expect(s.heard("hold")).toBe(false);
    await s.lock(async box => { await box.open("hold", one)!.commit(); });
    expect(s.heard("hold") && s.heardAny).toBe(true);
    expect(s.peek("hold", one)).toBeNull();
  });
});
