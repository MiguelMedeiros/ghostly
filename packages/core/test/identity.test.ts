import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MEMO_IDLE_MS, IDENTITY_MEMO_MAX, IDENTITY_MEMO_SIZE, identityFromSeed, identityFromSeedB64, setPublicKeyFastPath, sign, verify } from "../src/identity";
import { toBase64Url } from "../src/bytes";

// noble's ed25519 is frozen: a spy cannot go on it, so the module hands out a counting getPublicKey.
const derive = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const mod = await original<typeof import("@noble/curves/ed25519.js")>();
  return { ...mod, ed25519: { ...mod.ed25519, getPublicKey: (seed: Uint8Array) => { derive.calls++; return mod.ed25519.getPublicKey(seed); } } };
});
/** The key as noble derives it, outside the count. */
const keyOf = (seed: Uint8Array) => { const at = derive.calls; const key = ed25519.getPublicKey(seed); derive.calls = at; return key; };

/**
 * A chat's keys are derived from the same few seeds again and again at every start (its own seed by the link, its
 * delivery and its capability record; its participation seed by each of them too): an Ed25519 public key costs
 * ~0.25 ms in V8 and ~3.4x that in JSC. Each is derived once per run, and nothing secret is kept to do it.
 */
const seedOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7) & 0xff);

beforeEach(() => { derive.calls = 0; });
afterEach(() => { vi.useRealTimers(); setPublicKeyFastPath(null); });

describe("identityFromSeed", () => {
  it("derives a seed's public key once, however many times and from however many copies of the seed it is asked", () => {
    const seed = seedOf(1_001);
    const first = identityFromSeed(seed);
    const again = identityFromSeed(seed.slice());
    const fromB64 = identityFromSeedB64(toBase64Url(seed));
    expect(derive.calls).toBe(1);
    expect(again.pubKeyZ32).toBe(first.pubKeyZ32);
    expect(fromB64.publicKey).toEqual(first.publicKey);
    expect(first.publicKey).toEqual(keyOf(seed));
  });

  it("hands each caller an identity of its own: its own seed, and a public key no other caller shares", () => {
    const seed = seedOf(1_002);
    const copy = seed.slice();
    const a = identityFromSeed(seed);
    const b = identityFromSeed(copy);
    expect(a.seed).toBe(seed);
    expect(b.seed).toBe(copy);
    expect(b.publicKey).not.toBe(a.publicKey);
    a.publicKey.fill(0);
    expect(identityFromSeed(seed).publicKey).toEqual(b.publicKey);
  });

  it("a seed zeroed by its owner is a new seed: its key is the zero seed's, never the one before", () => {
    const seed = seedOf(1_003);
    const before = identityFromSeed(seed).pubKeyZ32;
    seed.fill(0);
    const after = identityFromSeed(seed);
    expect(after.pubKeyZ32).not.toBe(before);
    expect(after.publicKey).toEqual(keyOf(new Uint8Array(32)));
  });

  it("derives each key of a 600-chat start once: the load pass, then each link's own keys again and again", () => {
    // 3,954 distinct seeds over 600 chats, as a 600-chat, 50-group CLI profile holds: each chat's own seed and its
    // participation seed are asked by the load pass, then again by its link, delivery and capability record, along
    // with the few more seeds of its own the link derives.
    const chats = Array.from({ length: 600 }, (_, chat) =>
      Array.from({ length: chat < 354 ? 7 : 6 }, () => crypto.getRandomValues(new Uint8Array(32))));
    const distinct = chats.reduce((sum, seeds) => sum + seeds.length, 0);
    expect(distinct).toBe(3_954);
    for (const [own, participation] of chats) { identityFromSeed(own!); identityFromSeed(participation!); }
    for (const [own, participation, ...more] of chats) {
      for (const seed of more) { identityFromSeed(own!); identityFromSeed(seed); identityFromSeed(participation!); }
    }
    for (const [own, participation] of chats) { identityFromSeed(own!); identityFromSeed(participation!); }
    expect(derive.calls).toBe(distinct);
  });

  it("past its first keys, lets go of the ones not asked for a while: the oldest of them is derived again", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Later than every key the tests above kept, so they are all idle by now.
    vi.setSystemTime(Date.now() + 2 * IDENTITY_MEMO_IDLE_MS);
    // Seeds no other test uses: 32 random bytes each.
    const fresh = Array.from({ length: IDENTITY_MEMO_SIZE + 1 }, () => crypto.getRandomValues(new Uint8Array(32)));
    for (const seed of fresh) identityFromSeed(seed);
    identityFromSeed(fresh[0]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 1);
    vi.advanceTimersByTime(IDENTITY_MEMO_IDLE_MS - 1);
    identityFromSeed(fresh[IDENTITY_MEMO_SIZE]!);
    vi.advanceTimersByTime(1);
    // A new key makes room: the ones not asked for since they were first derived go.
    identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    identityFromSeed(fresh[1]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 3);
    identityFromSeed(fresh[0]!);
    identityFromSeed(fresh[IDENTITY_MEMO_SIZE]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 3);
  });

  // 16,385 keys derived: about 4 s on a desktop, past the default 5 s on a busy CI runner.
  it("keeps a bounded number of keys, used or not: past them, the oldest is derived again", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * IDENTITY_MEMO_IDLE_MS);
    const fresh = Array.from({ length: IDENTITY_MEMO_MAX + 1 }, () => crypto.getRandomValues(new Uint8Array(32)));
    for (const seed of fresh) identityFromSeed(seed);
    expect(derive.calls).toBe(IDENTITY_MEMO_MAX + 1);
    identityFromSeed(fresh[1]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_MAX + 1);
    identityFromSeed(fresh[0]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_MAX + 2);
  }, 60_000);

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => identityFromSeed(new Uint8Array(31))).toThrow("Seed must be exactly 32 bytes");
  });
});

describe("a host's faster public key", () => {
  it("derives the keys noble would not derive, each once, as the memo keeps noble's", () => {
    const asked: Uint8Array[] = [];
    setPublicKeyFastPath((seed) => { asked.push(seed.slice()); return keyOf(seed); });
    const seed = seedOf(2_001);
    const first = identityFromSeed(seed);
    expect(identityFromSeed(seed.slice()).pubKeyZ32).toBe(first.pubKeyZ32);
    expect(asked).toEqual([seed]);
    expect(derive.calls).toBe(0);
    expect(first.publicKey).toEqual(keyOf(seed));
  });

  it("leaves the key to noble when the host's throws or answers something that is not a key", () => {
    setPublicKeyFastPath(() => { throw new Error("no Ed25519 here"); });
    expect(identityFromSeed(seedOf(2_002)).publicKey).toEqual(keyOf(seedOf(2_002)));
    setPublicKeyFastPath(() => new Uint8Array(31));
    expect(identityFromSeed(seedOf(2_003)).publicKey).toEqual(keyOf(seedOf(2_003)));
    expect(derive.calls).toBe(2);
  });

  it("keeps a key of its own: the host's buffer written over later changes nothing", () => {
    const shared = new Uint8Array(32);
    setPublicKeyFastPath((seed) => { shared.set(keyOf(seed)); return shared; });
    const identity = identityFromSeed(seedOf(2_004));
    shared.fill(0);
    expect(identity.publicKey).toEqual(keyOf(seedOf(2_004)));
    expect(identityFromSeed(seedOf(2_004)).publicKey).toEqual(keyOf(seedOf(2_004)));
  });
});

describe("verify", () => {
  it("checks a signature, and refuses a key of small order and its constant signature of any message", () => {
    const seed = seedOf(9);
    const message = new TextEncoder().encode("any statement");
    expect(verify(sign(message, seed), message, keyOf(seed))).toBe(true);
    // The neutral point: no secret key goes with it, and R = the neutral point, S = 0 verifies anything under ZIP-215.
    const neutral = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));
    const constant = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
    expect(ed25519.verify(constant, message, neutral)).toBe(true);
    expect(verify(constant, message, neutral)).toBe(false);
  });
});
