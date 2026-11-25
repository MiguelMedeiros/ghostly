import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
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
});
