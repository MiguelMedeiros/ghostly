import type * as Identity from "../../src/identity";

/**
 * `identity`'s exports with `verify` answering a signature, message and key it already checked from what it answered
 * then: the same bytes, the same answer, as `verify` has no other input. For tests whose members on one in-memory
 * network all check every frame and every chain: there each frame's signature is checked once per member, ~1.3 ms of
 * pure-JS Ed25519 a time, most of the run. A test that counts `verify`'s calls must not use it.
 *
 *   vi.mock("../src/identity", async importOriginal => (await import("./support/verifyOnce")).verifyOnce(await importOriginal()));
 */
export function verifyOnce(actual: typeof Identity): typeof Identity {
  // By signature, then the message and key it was checked with: a forged one differs somewhere and is checked itself.
  const answered = new Map<string, { message: Uint8Array; publicKey: Uint8Array; ok: boolean }[]>();
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const verify: typeof actual.verify = (signature, message, publicKey) => {
    const key = Buffer.from(signature).toString("base64");
    const list = answered.get(key) ?? [];
    const hit = list.find(e => same(e.message, message) && same(e.publicKey, publicKey));
    if (hit) return hit.ok;
    const ok = actual.verify(signature, message, publicKey);
    list.push({ message: Uint8Array.from(message), publicKey: Uint8Array.from(publicKey), ok });
    answered.set(key, list);
    return ok;
  };
  return { ...actual, verify };
}
