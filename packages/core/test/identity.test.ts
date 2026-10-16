import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MEMO_SIZE, identityFromSeed, identityFromSeedB64 } from "../src/identity";
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

  it("keeps a bounded number of keys: past them, the oldest is derived again", () => {
    // Seeds no other test uses: 32 random bytes each.
    const fresh = Array.from({ length: IDENTITY_MEMO_SIZE + 1 }, () => crypto.getRandomValues(new Uint8Array(32)));
    for (const seed of fresh) identityFromSeed(seed);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 1);
    identityFromSeed(fresh[IDENTITY_MEMO_SIZE]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 1);
    identityFromSeed(fresh[0]!);
    expect(derive.calls).toBe(IDENTITY_MEMO_SIZE + 2);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => identityFromSeed(new Uint8Array(31))).toThrow("Seed must be exactly 32 bytes");
  });
});
