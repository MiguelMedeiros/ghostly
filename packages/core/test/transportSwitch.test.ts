import { afterEach, expect, it, vi } from "vitest";
import { TransportSwitch, type TransportPolicy, type SwitchPlan } from "../src/transportSwitch";
import { TransportSwitch as TransportSwitchV114 } from "./support/transportSwitchV114";
// covers: transport.switch, transport.preference, transport.wait

/**
 * Two switches wired to each other. The coordinator's dial starts as `prepare` asks for it (a native dial does), unless
 * `holdDial`: then it waits, as a move back to WebRTC waits for the session it left to retire, until `dial()` starts it.
 * `old`: side 1 (not the coordinator) is the switch v1.1.4 shipped, whose policy does not say `replaces`.
 */
function peers(options: { waits?: boolean; holdDial?: boolean; old?: boolean } = {}) {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [0, 1].map(() => ({ preferred: "webrtc/1", fallback: true,
    available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": "iroh", "hyperdht/1": "hyper" } }));
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const state = [vi.fn(), vi.fn()], prepare = [vi.fn(), vi.fn()], cancel = [vi.fn(), vi.fn()], unreached = [vi.fn(), vi.fn()], kept = [vi.fn(), vi.fn()];
  let held: SwitchPlan | null = null;
  const switches: TransportSwitch[] = [];
  prepare[0].mockImplementation((plan: SwitchPlan, dial: boolean) => { if (!dial) return; if (options.holdDial) held = plan; else switches[0].dialing(plan); });
  const dial = () => { if (held) switches[0].dialing(held); held = null; };
  switches.push(...[0, 1].map(i => new (i === 1 && options.old ? TransportSwitchV114 as unknown as typeof TransportSwitch : TransportSwitch)({ key: String(i), peerKey: String(1-i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({side: 1-i, frame: frame as Record<string, unknown>}),
    peer: vi.fn(), state: state[i], prepare: prepare[i], cancel: cancel[i], kept: kept[i], timeoutMs: 100, ...(options.waits ? { unreached: unreached[i] } : {}) })));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const {side, frame} = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("session-1", "webrtc/1")); flush();
  return { policies, queue, state, prepare, cancel, unreached, kept, switches, flush, dial };
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
it.each([0, 1])("plans a choice made on side %s while another move was dialling, once that move fails (WISP 100)", side => {
  const h = peers({ waits: true }); h.policies[1].preferred = "hyperdht/1";
  h.switches[1].changed(); h.flush();
  // The coordinator dials HyperDHT (`go` sent): a newer choice cannot cut in, it waits for that move to end.
  expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["hyperdht/1"]) }), true);
  h.policies[side].preferred = "iroh/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  // The HyperDHT move fails (here its time ran out: the chat was busy). Iroh is what both policies want now: planned
  // at once, not left waiting with nothing to try it until someone chooses again.
  h.switches[0].fail("Transport change timed out."); h.flush();
  expect(h.switches.map(s => s.wanted()?.transport)).toEqual(["iroh/1", "iroh/1"]);
  expect(h.switches.every(s => s.pending?.choices[0] === "iroh/1")).toBe(true);
  expect(h.prepare[0]).toHaveBeenLastCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["iroh/1"]) }), true);
  h.switches.forEach(s => s.stop());
});
it.each([0, 1])("a choice made on side %s before the planned move dialled replaces it: back where the chat is, no move", side => {
  const h = peers({ waits: true, holdDial: true });
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  // Back to WebRTC: both sides agreed, the coordinator waits for the old WebRTC session to retire before it dials.
  h.policies[side].preferred = "webrtc/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "webrtc/1")).toBe(true);
  expect(h.prepare[0]).toHaveBeenLastCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["webrtc/1"]) }), true);
  // Iroh again, still before the dial: the move is dropped on both sides, and nothing is said missed.
  h.policies[side].preferred = "iroh/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.cancel[0]).toHaveBeenCalled();
  h.dial();
  [...h.kept, ...h.unreached].forEach(f => expect(f).not.toHaveBeenCalled());
  expect(h.switches.map(s => s.wanted()?.transport)).toEqual(["iroh/1", "iroh/1"]);
  h.state.forEach(s => expect(s.mock.lastCall).toEqual([]));
  h.switches.forEach(s => s.stop());
});
it.each([0, 1])("a choice made on side %s before the planned move dialled replaces it: the newer target is planned at once", side => {
  const h = peers({ waits: true, holdDial: true });
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  h.policies[side].preferred = "webrtc/1"; h.switches[side].changed(); h.flush();
  h.policies[side].preferred = "hyperdht/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  expect(h.prepare[0]).toHaveBeenLastCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["hyperdht/1"]) }), true);
  [...h.kept, ...h.unreached].forEach(f => expect(f).not.toHaveBeenCalled());
  // Once that move dials, a newer choice waits for it, as before.
  h.dial();
  h.policies[side].preferred = "iroh/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
/**
 * A contact on v1.1.4 knows `paired-switch-keep` only as "the move did not connect, the chat stays here": for a move a
 * newer choice had replaced, it said the target was missed (a "kept on" row), and with Fallback off it held the dropped
 * plan until its timeout said the change failed. Its policy does not say `replaces`: the move goes on, and the newer
 * choice is planned once it landed, as before.
 */
for (const fallback of [true, false]) it.each([0, 1])(`a choice made on side %s before the planned move dialled, with a v1.1.4 contact and fallback ${fallback}: no notice, the move lands, then the newer one`, side => {
  vi.useFakeTimers();
  const h = peers({ waits: true, holdDial: true, old: true });
  h.policies.forEach(p => { p.preferred = "iroh/1"; }); h.policies[side].fallback = fallback;
  h.switches.forEach(s => s.begin("session-2", "iroh/1")); h.flush();
  h.policies[side].preferred = "webrtc/1"; h.switches[side].changed(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "webrtc/1")).toBe(true);
  // Iroh again, before the dial: the v1.1.4 contact is not told the move was dropped, which it would read as missed.
  h.policies[side].preferred = "iroh/1"; h.switches[side].changed(); h.flush();
  vi.advanceTimersByTime(50);
  [...h.kept, ...h.unreached].forEach(f => expect(f).not.toHaveBeenCalled());
  expect(h.switches.every(s => s.pending?.choices[0] === "webrtc/1")).toBe(true);
  h.dial(); h.switches.forEach(s => s.begin("session-3", "webrtc/1", true)); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "iroh/1")).toBe(true);
  h.dial(); h.switches.forEach(s => s.begin("session-4", "iroh/1", true)); h.flush();
  vi.advanceTimersByTime(1_000);
  [...h.kept, ...h.unreached].forEach(f => expect(f).not.toHaveBeenCalled());
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.switches.map(s => s.wanted()?.transport)).toEqual(["iroh/1", "iroh/1"]);
  h.switches.forEach(s => s.stop());
});
it("does not plan a failed move again by itself when nothing changed since (the owner's retry pace does)", () => {
  const h = peers({ waits: true }); h.policies[1].preferred = "hyperdht/1"; h.policies[1].fallback = false;
  h.switches[1].changed(); h.flush();
  h.switches[0].fail("hyperdht/1 unreachable"); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledTimes(1);
  expect(h.switches.every(s => !s.pending)).toBe(true);
  h.switches.forEach(s => s.stop());
});
it.each([0, 1])("a move that lands on a fallback choice leaves its target unreached on both sides, chosen on side %s (WISP 100)", side => {
  const h = peers({ waits: true });
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  h.policies[side].preferred = "hyperdht/1"; h.switches[side].changed(); h.flush();
  const plan = h.prepare[0].mock.lastCall![0] as SwitchPlan;
  expect(plan.choices[0]).toBe("hyperdht/1");
  expect(plan.choices).toContain("webrtc/1");
  // HyperDHT did not connect; WebRTC, ranked before the Iroh the chat was on, did: the session moved there.
  h.switches.forEach(s => s.begin("session-3", "webrtc/1", true)); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  // Both still want HyperDHT, and both are told it was not reached: the owner waits for it and tries it again,
  // as when a fallback keeps the chat where it was. Before, nothing said so, and nothing tried it again.
  expect(h.switches.map(s => s.wanted()?.transport)).toEqual(["hyperdht/1", "hyperdht/1"]);
  h.kept.forEach(k => expect(k).toHaveBeenCalledWith("hyperdht/1"));
  h.switches[0].again(); h.flush();
  expect(h.switches.every(s => s.pending?.choices[0] === "hyperdht/1")).toBe(true);
  h.switches.forEach(s => s.stop());
});
it("a move that lands on its target is no fallback: nothing is left unreached", () => {
  const h = peers({ waits: true }); h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  h.kept.forEach(k => expect(k).not.toHaveBeenCalled());
  expect(h.switches.map(s => s.wanted()?.transport)).toEqual(["iroh/1", "iroh/1"]);
  h.switches.forEach(s => s.stop());
});
it("a contact whose app started again and took the session over (no stop on this side) is heard at its new revisions", () => {
  // The CLI's daemon killed and started again: its app knocks on the native endpoint, and this side takes the new
  // connection as a replacement of the session it still held (`attachReplacement`), with no drop in between. The new
  // app counts its policy revisions from 0 again. Before, this side kept the old app's policy (revision 6 here) and
  // dropped every newer one as older: neither a choice made here nor one made there moved the chat ("Your contact did
  // not answer" / "Transport change timed out", every time, until the restarted app's revisions passed the old ones).
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [0, 1].map(() => ({ preferred: "webrtc/1", fallback: true,
    available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": "iroh", "hyperdht/1": "hyper" } }));
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const prepare = [vi.fn(), vi.fn()];
  const make = (i: number) => new TransportSwitch({ key: String(i), peerKey: String(1 - i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({ side: 1 - i, frame: frame as Record<string, unknown> }),
    peer: vi.fn(), state: vi.fn(), prepare: prepare[i], cancel: vi.fn(), unreached: vi.fn(), timeoutMs: 100 });
  const switches = [make(0), make(1)];
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const { side, frame } = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("session-1", "webrtc/1")); flush();
  // The coordinator's app (key 0) changes its policy a few times on that session.
  for (let n = 0; n < 6; n++) { switches[0].changed(false); flush(); }
  expect(switches[1].peerPolicy?.revision).toBe(6);

  // Killed, and started again: a new app, revision 0, on a session that replaces the old one here.
  switches[0] = make(0);
  switches.forEach(s => s.begin("session-2", "iroh/1")); flush();
  // A choice on the side that stayed up is planned by the restarted coordinator and dialled.
  policies[1].preferred = "hyperdht/1"; switches[1].changed(); flush();
  expect(prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["hyperdht/1"]) }), true);
  expect(prepare[1]).toHaveBeenCalledWith(expect.objectContaining({ choices: expect.arrayContaining(["hyperdht/1"]) }), false);
  switches.forEach(s => s.stop());
});
