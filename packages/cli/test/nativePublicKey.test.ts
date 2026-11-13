import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { nativePublicKey } from "../src/nativeEd25519";
// covers: headless.one-shot

// noble's ed25519 is frozen: a spy cannot go on it, so the module hands out a counting getPublicKey.
const noble = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const mod = await original<typeof import("@noble/curves/ed25519.js")>();
  return { ...mod, ed25519: { ...mod.ed25519, getPublicKey: (seed: Uint8Array) => { noble.calls++; return mod.ed25519.getPublicKey(seed); } } };
});

/**
 * Each command run without a daemon is a new process, and its start derives two Ed25519 public keys for every chat of
 * the profile (its own seed and its participation seed): noble's took ~115 ms of a one-shot's ~450 ms of CPU at 200
 * chats. The engine's runtime has Node's derive them, and they are the same keys.
 */
describe("a seed's public key in the CLI", () => {
  it("is the key noble derives, for any seed", () => {
    const seeds = [new Uint8Array(32), new Uint8Array(32).fill(0xff), ...Array.from({ length: 300 }, () => randomBytes(32))];
    for (const seed of seeds) expect(Buffer.from(nativePublicKey(seed)).toString("hex")).toBe(Buffer.from(ed25519.getPublicKey(seed)).toString("hex"));
  });

  it("is derived by Node's Ed25519 once the engine's runtime is loaded, not by noble", async () => {
    await import("../src/runtime/engine");
    const { identityFromSeed } = await import("@ghostly/core");
    const seed = randomBytes(32);
    noble.calls = 0;
    const identity = identityFromSeed(seed);
    expect(noble.calls).toBe(0);
    noble.calls = 0;
    expect(identity.publicKey).toEqual(ed25519.getPublicKey(seed));
  });
});
