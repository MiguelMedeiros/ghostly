import { afterEach, expect, it, vi } from "vitest";
import { TransportSwitch, type TransportPolicy, type SwitchPlan } from "../src/transportSwitch";
// covers: transport.switch, transport.preference

function peers(options: { waits?: boolean } = {}) {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [0, 1].map(() => ({ preferred: "webrtc/1", fallback: true,
    available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": "iroh", "hyperdht/1": "hyper" } }));
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const state = [vi.fn(), vi.fn()], prepare = [vi.fn(), vi.fn()], cancel = [vi.fn(), vi.fn()], unreached = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1-i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({side: 1-i, frame: frame as Record<string, unknown>}),
    peer: vi.fn(), state: state[i], prepare: prepare[i], cancel: cancel[i], timeoutMs: 100, ...(options.waits ? { unreached: unreached[i] } : {}) }));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const {side, frame} = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("session-1", "webrtc/1")); flush();
  return { policies, queue, state, prepare, cancel, unreached, switches, flush };
}
afterEach(() => vi.useRealTimers());
it.each([0, 1])("lets endpoint %s propose with no creator privilege", side => {
  const h = peers(); h.policies[side].preferred = "hyperdht/1"; h.policies[side].fallback = false;
  h.switches[side].changed(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({choices:["hyperdht/1"]}), true);
  expect(h.prepare[1]).toHaveBeenCalledWith(expect.objectContaining({choices:["hyperdht/1"]}), false);
  h.switches.forEach(s => s.begin("session-2", "hyperdht/1")); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("blocks strict conflicts then recovers through the same control channel", () => {
  const h = peers(); h.policies[0].preferred = "iroh/1"; h.policies[1].preferred = "hyperdht/1";
  h.policies.forEach(p => p.fallback = false); h.switches.forEach(s => s.changed()); h.flush();
  h.state.forEach(s => expect(s).toHaveBeenLastCalledWith(expect.stringContaining("do not overlap")));
  expect(h.prepare.every(s => !s.mock.calls.length)).toBe(true);
  h.policies[0].preferred = "hyperdht/1"; h.switches[0].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("resolves simultaneous proposals by shared key order, and retries a superseded plan", () => {
  const h = peers(); h.policies[0].preferred = "iroh/1"; h.policies[1].preferred = "hyperdht/1";
  h.switches.forEach(s => s.changed()); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "iroh/1")).toBe(true);
  h.policies[1].preferred = "hyperdht/1"; h.switches[1].changed(); h.flush();
  h.switches.forEach(s => s.begin("session-2", "iroh/1")); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("rejects stale contexts and mutations at the same policy revision", () => {
  const h = peers(), old = h.switches[0].peerPolicy!;
  h.switches[0].handle({ t:"paired-policy", context:"session-1", policy:{...old, preferred:"iroh/1"} });
  expect(h.switches[0].peerPolicy).toEqual(old);
  h.switches[0].handle({ t:"paired-policy", context:"old-session", policy:{...old, revision:100, preferred:"iroh/1"} });
  expect(h.switches[0].peerPolicy).toEqual(old); h.switches.forEach(s => s.stop());
});
it("bounds an unanswered follower proposal and an unproved candidate", () => {
  vi.useFakeTimers(); const h = peers();
  h.policies[1].preferred = "iroh/1"; h.switches[1].changed();
  vi.advanceTimersByTime(101);
  expect(h.state[1]).toHaveBeenLastCalledWith(expect.stringContaining("did not acknowledge"));
  h.switches[1].retry(); h.flush(); vi.advanceTimersByTime(101); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.cancel[0]).toHaveBeenCalled(); h.switches.forEach(s => s.stop());
});
it("settles mutual fallback without a repeating switch loop", () => {
  const h = peers(); h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  expect((h.prepare[0].mock.calls[0][0] as SwitchPlan).choices).toContain("webrtc/1");
  h.switches[0].keep(); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  h.switches.forEach(s => s.retry()); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledTimes(1); h.switches.forEach(s => s.stop());
});
it("agrees again on a fresh session: a plan cut short by a drop does not settle the reconnect", () => {
  const h = peers(); h.policies[1].preferred = "hyperdht/1"; h.switches[1].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  // The link drops before the move; the redial lands on WebRTC, a transport the old plan would also have allowed.
  h.switches.forEach(s => s.stop());
  h.switches.forEach(s => s.begin("session-2", "webrtc/1")); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  expect(h.prepare[0]).toHaveBeenCalledTimes(2);
  // The move lands: that session is the plan's, so it is settled and nothing moves again.
  h.switches.forEach(s => s.begin("session-3", "hyperdht/1", true)); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.prepare[0]).toHaveBeenCalledTimes(2);
  h.switches.forEach(s => s.stop());
});
it("does not keep a fallback settled on an older session", () => {
  const h = peers(); h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  h.switches[0].keep(); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  // Reconnected on the same transport: Iroh is still the contact's choice, so this session tries it once more.
  h.switches.forEach(s => s.stop());
  h.switches.forEach(s => s.begin("session-2", "webrtc/1")); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "iroh/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("names the same redial target on both sides: the explicit choice, or none", () => {
  const h = peers();
  expect(h.switches.map(s => s.chosenTarget)).toEqual([undefined, undefined]);
  h.policies[1].preferred = "hyperdht/1"; h.switches[1].changed(); h.flush();
  h.switches.forEach(s => s.stop());
  // Kept across the drop, for the next dial, on either side.
  expect(h.switches.map(s => s.chosenTarget)).toEqual(["hyperdht/1", "hyperdht/1"]);
  h.switches.forEach(s => s.begin("session-2", "hyperdht/1")); h.flush();
  h.policies[0].preferred = "iroh/1"; h.switches[0].changed(); h.flush();
  expect(h.switches.map(s => s.chosenTarget)).toEqual(["iroh/1", "iroh/1"]);
  // Back to automatic on side 0: side 1's standing choice names the target again.
  h.policies[0].preferred = "webrtc/1"; h.switches[0].changed("automatic"); h.flush();
  expect(h.switches.map(s => s.chosenTarget)).toEqual(["hyperdht/1", "hyperdht/1"]);
  h.switches.forEach(s => s.stop());
});
it("choosing again what this side's standing choice names raises no intent; an override of the contact's does", () => {
  const h = peers();
  const intent = (side: number) => h.switches[1 - side].peerPolicy!.intent;
  h.policies[0].preferred = "iroh/1"; h.switches[0].chose(); h.flush();
  expect(intent(0)).toBe(1);
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  expect(h.switches[0].standing).toBe(true);
  // The same choice again, or a new fallback (a policy change, not a choice): the intent stays, the policy goes out,
  // and nothing moves.
  h.switches[0].chose(true); h.flush();
  h.policies[0].fallback = false; h.switches[0].changed(false); h.flush();
  expect(intent(0)).toBe(1);
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.switches[1].peerPolicy!.fallback).toBe(false);
  h.policies[0].fallback = true; h.switches[0].changed(false); h.flush();
  expect(intent(0)).toBe(1);
  // So a contact's newer choice, sent before it saw those, still wins: no tie for the key order to break.
  h.policies[1].preferred = "hyperdht/1"; h.switches[1].chose(); h.flush();
  expect(intent(1)).toBe(2);
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  expect(h.switches[0].standing).toBe(false);
  // Choosing Iroh again now overrides the contact's standing choice: that one raises the intent.
  h.switches.forEach(s => s.begin("session-3", "hyperdht/1", true)); h.flush();
  h.switches[0].chose(true); h.flush();
  expect(intent(0)).toBe(3);
  expect(h.switches.every(s => s.pending?.choices[0] === "iroh/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("falls back to a relayed transport only after the direct ones, and still honours an explicit choice of it", () => {
  const plain = peers(); plain.policies.forEach(p => p.preferred = "iroh/1"); plain.switches[1].changed(); plain.flush();
  expect((plain.prepare[0].mock.calls[0][0] as SwitchPlan).choices).toEqual(["iroh/1", "hyperdht/1", "webrtc/1"]);
  plain.switches.forEach(s => s.stop());
  // The same policies with one side's HyperDHT reached through a relay (a browser): WebRTC comes before it.
  const h = peers(); h.policies.forEach(p => p.preferred = "iroh/1");
  h.policies[0].descriptors = { ...h.policies[0].descriptors, "hyperdht/1": { publicKey: "ab".repeat(32), relayed: true } };
  h.switches[1].changed(); h.flush();
  for (const prepare of h.prepare) expect((prepare.mock.calls[0][0] as SwitchPlan).choices).toEqual(["iroh/1", "webrtc/1", "hyperdht/1"]);
  h.switches.forEach(s => s.begin("session-2", "iroh/1")); h.flush();
  h.policies[1].preferred = "hyperdht/1"; h.switches[1].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});

it("waits for a target that did not connect, rather than failing, when its owner waits (WISP 100)", () => {
  const h = peers({ waits: true }); h.policies[1].preferred = "hyperdht/1"; h.policies[1].fallback = false;
  h.switches[1].changed(); h.flush();
  expect(h.switches.map(s => s.wanted())).toEqual([{ transport: "hyperdht/1", by: "contact" }, { transport: "hyperdht/1", by: "you" }]);
  h.switches[0].fail("Transport change failed: hyperdht/1 unreachable."); h.flush();
  // The side that dialled knows why; the other, only that it did not happen. Neither is an error.
  expect(h.unreached[0]).toHaveBeenCalledWith("hyperdht/1", "Transport change failed: hyperdht/1 unreachable.");
  expect(h.unreached[1]).toHaveBeenCalledWith("hyperdht/1", undefined);
  h.state.forEach(s => expect(s.mock.lastCall?.[0]).toBeUndefined());
  expect(h.switches.every(s => !s.pending)).toBe(true);
  // Tried again: the coordinator plans anew.
  h.switches[0].again(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledTimes(2);
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("tries again from either side: the other side's policy goes out anew, and the coordinator plans", () => {
  const h = peers({ waits: true }); h.policies[1].preferred = "hyperdht/1"; h.policies[1].fallback = false;
  h.switches[1].changed(); h.flush();
  h.switches[0].fail("hyperdht/1 unreachable"); h.flush();
  const revision = h.switches[0].peerPolicy!.revision;
  h.switches[1].again(); h.flush();
  expect(h.switches[0].peerPolicy!.revision).toBe(revision + 1);
  expect(h.prepare[0]).toHaveBeenCalledTimes(2);
  h.switches.forEach(s => s.stop());
});
it("tries a target kept on a fallback again, and waits for one the other side does not run instead of calling it a conflict", () => {
  const h = peers({ waits: true }); h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  h.switches[0].keep("iroh unreachable"); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.switches[1].wanted()).toEqual({ transport: "iroh/1", by: "you" });
  h.switches[0].again(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledTimes(2);
  h.switches.forEach(s => s.stop());

  const w = peers({ waits: true }); w.policies[0].available = ["webrtc/1", "iroh/1"];
  w.policies[1].preferred = "hyperdht/1"; w.policies[1].fallback = false; w.switches[1].changed(); w.flush();
  // Side 0 has no HyperDHT (yet): no error on either side, and what is wanted is still HyperDHT.
  w.state.forEach(s => expect(s.mock.lastCall?.[0]).toBeUndefined());
  expect(w.prepare.every(s => !s.mock.calls.length)).toBe(true);
  expect(w.switches[0].wanted()).toEqual({ transport: "hyperdht/1", by: "contact" });
  w.switches.forEach(s => s.stop());
});
