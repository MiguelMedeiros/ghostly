import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.handoff

/**
 * WISP 06 § States and events: a request while a call is on gets `handoff-busy`. The giver asks the engine why it cannot
 * hand over now (`handoffBusy`, for a pull, a push and the stop before pass 2); with a call on, the answer is the call,
 * which the active device's screen words as "A call is on. Try again after it."
 */
it("refuses a handoff while a call is on, and gives the call as the reason", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  const busy = () => (node as unknown as { handoffBusy(): Promise<{ why: string } | null> }).handoffBusy();
  node.setCallOn({ on: true });
  expect(await busy()).toEqual({ why: "call" });
  node.setCallOn({ on: false });
  expect((await busy())?.why).not.toBe("call");
});
