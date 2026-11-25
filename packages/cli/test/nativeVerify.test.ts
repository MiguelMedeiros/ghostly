import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { nativeEd25519 } from "../src/nativeEd25519";
// covers: headless.one-shot

// noble's ed25519 is frozen: a spy cannot go on it, so the module hands out a counting verify.
const noble = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const mod = await original<typeof import("@noble/curves/ed25519.js")>();
  return { ...mod, ed25519: { ...mod.ed25519, verify: (...args: Parameters<typeof mod.ed25519.verify>) => { noble.calls++; return mod.ed25519.verify(...args); } } };
});

/**
 * A community member checks the signature of each frame it takes: noble's check took ~2.8 ms where Node's takes ~0.17 ms,
 * and was 79% of the CPU of a 128-member community's engines. The engine's runtime has Node's check them; a bad one is
 * still refused (by noble's strict check, which answers whenever Node's says no).
 */
describe("a signature the CLI's engine checks", () => {
  it("is checked by Node's Ed25519 once the engine's runtime is loaded, not by noble", async () => {
    await import("../src/runtime/engine");
    const { verify, utf8Encode } = await import("@ghostly/core");
    const seed = randomBytes(32), key = ed25519.getPublicKey(seed), message = utf8Encode("a group frame");
    const signature = ed25519.sign(message, seed);
    noble.calls = 0;
    expect(verify(signature, message, key)).toBe(true);
    expect(noble.calls).toBe(0);
    const forged = signature.slice();
    forged[0] ^= 1;
    expect(verify(forged, message, key)).toBe(false);
    expect(verify(signature, utf8Encode("another frame"), key)).toBe(false);
  });

  it("is refused by Node's check alone and by noble's strict check alike when S is out of range, the key is of small order or a bit is flipped", () => {
    const L = ed25519.Point.Fn.ORDER;
    const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
    const sOf = (sig: Uint8Array) => sig.subarray(32).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
    const withS = (sig: Uint8Array, s: bigint) => Uint8Array.from([...sig.subarray(0, 32), ...le(s)]);
    const seed = randomBytes(32), key = ed25519.getPublicKey(seed), message = new TextEncoder().encode("a group frame");
    const good = ed25519.sign(message, seed);
    const flipped = good.slice();
    flipped[40] ^= 1;
    // A point of order 2.
    const orderTwo = le((1n << 255n) - 20n);
    const cases: [string, Uint8Array, Uint8Array][] = [
      ["S + L", withS(good, sOf(good) + L), key],
      ["S = L", withS(good, L), key],
      ["small-order key (order 2)", good, orderTwo],
      ["one bit flipped", flipped, key],
    ];
    const refused = (check: () => boolean) => { try { return !check(); } catch { return true; } };
    for (const [name, sig, pub] of cases) {
      expect({ name, native: refused(() => nativeEd25519(sig, message, pub)) }).toEqual({ name, native: true });
      expect({ name, noble: refused(() => ed25519.verify(sig, message, pub, { zip215: false })) }).toEqual({ name, noble: true });
    }
    expect(nativeEd25519(good, message, key)).toBe(true);
    expect(ed25519.verify(good, message, key, { zip215: false })).toBe(true);
  });

  it("keeps a small-order key away from Node's check, whatever Node's own answer for it", async () => {
    await import("../src/runtime/engine");
    const { verify } = await import("@ghostly/core");
    const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
    const identity = le(1n), identitySig = Uint8Array.from([...identity, ...le(0n)]);
    const message = new TextEncoder().encode("any message at all");
    // Node's own check said yes to this for any message on Node 22.23 and no on Node 24 and 26, so it is not pinned
    // here: the gate never asks it about a key of small order, and noble's strict check answers.
    expect(ed25519.verify(identitySig, message, identity, { zip215: false })).toBe(false);
    expect(verify(identitySig, message, identity)).toBe(false);
  });
});
