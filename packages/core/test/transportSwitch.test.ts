import { afterEach, expect, it, vi } from "vitest";
import { TransportSwitch, type TransportPolicy, type SwitchPlan } from "../src/transportSwitch";
// covers: transport.switch, transport.preference

function peers() {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [0, 1].map(() => ({ preferred: "webrtc/1", fallback: true,
    available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": "iroh", "hyperdht/1": "hyper" } }));
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const state = [vi.fn(), vi.fn()], prepare = [vi.fn(), vi.fn()], cancel = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1-i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({side: 1-i, frame: frame as Record<string, unknown>}),
    peer: vi.fn(), state: state[i], prepare: prepare[i], cancel: cancel[i], timeoutMs: 100 }));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const {side, frame} = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("session-1", "webrtc/1")); flush();
  return { policies, queue, state, prepare, cancel, switches, flush };
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
