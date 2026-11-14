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

type Engine = {
  handoffBusy(): Promise<{ why: string } | null>;
  callSignalHeard(linkId: string, signal: string): void;
  quiesceForHandoff(patch: object): Promise<{ why: string } | null | void>;
  cancelPendingReviews(): Promise<void>;
  shutdown(options?: object): Promise<void>;
};
const offer = (ts = Date.now()) => JSON.stringify({ t: "o", ts, u: "abcd", p: "abcdefghijklmnopqrstuv", f: "a".repeat(64), s: "actpass" });

/**
 * A contact's offer the engine heard before any page rang it (a page opening, or the ring not drawn yet) is a call too:
 * a pull answered then moved the profile, and the call was lost with no Missed call line.
 */
it("refuses a handoff while a contact's offer waits in the engine with no page ringing, until it is handled or too old", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  const engine = node as unknown as Engine;
  engine.callSignalHeard("chat-1", offer());
  expect(await engine.handoffBusy()).toEqual({ why: "call" });
  // The contact hung up: nothing rings any more.
  engine.callSignalHeard("chat-1", JSON.stringify({ t: "h", ts: Date.now() }));
  expect((await engine.handoffBusy())?.why).not.toBe("call");
  // A page declined it.
  engine.callSignalHeard("chat-1", offer());
  await node.setCallSignal({ linkId: "chat-1", signal: JSON.stringify({ t: "h", ts: Date.now() }) });
  expect((await engine.handoffBusy())?.why).not.toBe("call");
  // An offer too old to ring keeps nothing here.
  engine.callSignalHeard("chat-1", offer(Date.now() - 10 * 60_000));
  expect((await engine.handoffBusy())?.why).not.toBe("call");
});

/** The giver's last check runs before the freeze's awaits: a call that starts ringing during them keeps the profile here. */
it("stops nothing at the freeze when a call came in after the giver's last check", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  const engine = node as unknown as Engine;
  engine.cancelPendingReviews = async () => engine.callSignalHeard("chat-1", offer());
  const shutdown = vi.spyOn(engine, "shutdown");
  expect(await engine.quiesceForHandoff({ handoff: { role: "releasing", step: "pass2" } })).toEqual({ why: "call" });
  expect(shutdown).not.toHaveBeenCalled();
});
