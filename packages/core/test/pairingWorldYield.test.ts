import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeWorld, useFakeWorld, yieldToLoop } from "./support/pairingWorld";

// covers: core.liveness

/**
 * The pairing world steps fake time 50-100 ms at a time with `yieldToLoop` between steps: restartRelink.test.ts alone
 * makes about 100,000 of them. A real `setTimeout(…, 0)` there waited Node's 1 ms each, which made restartRelink 190 s
 * of CI time and the 33 files on this world 460 s (bug hunt, 2026-11-13: 48 s with one turn of the loop).
 */
describe("the pairing world's yield between steps of fake time", () => {
  beforeEach(() => useFakeWorld());
  afterEach(() => closeWorld());

  it("takes no real millisecond per step", async () => {
    const steps = 500, start = performance.now();
    for (let i = 0; i < steps; i++) await yieldToLoop();
    // Before: 500 ms or more, 1 ms a step whatever the machine.
    expect(performance.now() - start).toBeLessThan(steps / 2);
  });

  it("returns once the WebCrypto work the last step started is done, so where it lands in fake time is the machine's speed in no way", async () => {
    // Long enough on any machine that a turn of the loop alone (or 1 ms) does not see it through.
    const bytes = new Uint8Array(32 * 1024 * 1024);
    let done = false;
    void crypto.subtle.digest("SHA-256", bytes).then(() => { done = true; });
    await yieldToLoop();
    expect(done).toBe(true);
  });
});
