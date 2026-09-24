import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportSwitch, type TransportPolicy } from "../src/transportSwitch";

/** Two switches wired through an explicit queue: nothing moves until `flush`. Key "0" coordinates. */
function peers(timeoutMs?: number) {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [0, 1].map(() => ({ preferred: "webrtc/1", fallback: true,
    available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": "iroh", "hyperdht/1": "hyper" } }));
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const sent: Record<string, unknown>[][] = [[], []];
  const state = [vi.fn(), vi.fn()], prepare = [vi.fn(), vi.fn()], cancel = [vi.fn(), vi.fn()], peer = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1 - i),
    policy: () => structuredClone(policies[i]),
    send: frame => { sent[i].push(frame as Record<string, unknown>); queue.push({ side: 1 - i, frame: frame as Record<string, unknown> }); },
    peer: peer[i], state: state[i], prepare: prepare[i], cancel: cancel[i], ...(timeoutMs ? { timeoutMs } : {}) }));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const { side, frame } = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("ctx", "webrtc/1")); flush();
  return { policies, queue, sent, state, prepare, cancel, peer, switches, flush };
}
afterEach(() => vi.useRealTimers());

describe("transport switch: peer policy parsing", () => {
  const good = { revision: 5, intent: 0, preferred: "iroh/1", fallback: true, available: ["iroh/1"], descriptors: {} };
  it.each([
    ["null", null],
    ["a string", "policy"],
    ["a negative revision", { ...good, revision: -1 }],
    ["a fractional revision", { ...good, revision: 5.5 }],
    ["a negative intent", { ...good, intent: -1 }],
    ["an unknown preferred transport", { ...good, preferred: "tcp/1" }],
    ["a non-boolean fallback", { ...good, fallback: "yes" }],
    ["a non-list of available transports", { ...good, available: "iroh/1" }],
    ["more than three available transports", { ...good, available: ["iroh/1", "webrtc/1", "hyperdht/1", "iroh/1"] }],
    ["duplicate available transports", { ...good, available: ["iroh/1", "iroh/1"] }],
    ["an unknown available transport", { ...good, available: ["iroh/1", "tcp/1"] }],
    ["missing descriptors", { ...good, descriptors: null }],
    ["non-object descriptors", { ...good, descriptors: "x" }],
    ["descriptors over 4 KiB", { ...good, descriptors: { "iroh/1": "x".repeat(4096) } }],
  ])("ignores a policy with %s", (_, policy) => {
    const h = peers(), before = h.switches[0].peerPolicy;
    expect(h.switches[0].handle({ t: "paired-policy", context: "ctx", policy })).toBe(true);
    expect(h.switches[0].peerPolicy).toEqual(before);
  });

  it("keeps only native descriptors from a peer policy", () => {
    const h = peers();
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { ...good, descriptors: { "iroh/1": "i", "webrtc/1": "w", "__proto__x": 1 } } });
    expect(h.switches[0].peerPolicy?.descriptors).toEqual({ "iroh/1": "i" });
    expect(h.peer[0]).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 5 }));
  });

  it("ignores an older revision and accepts a newer one", () => {
    const h = peers();
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { ...good, revision: 5 } });
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { ...good, revision: 4, preferred: "hyperdht/1" } });
    expect(h.switches[0].peerPolicy?.revision).toBe(5);
    // The identical policy again is accepted as a no-op.
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { ...good, revision: 5 } });
    expect(h.switches[0].peerPolicy?.preferred).toBe("iroh/1");
  });
});

describe("transport switch: frames out of place", () => {
  it("does not claim frames that are not switch frames", () => {
    const h = peers();
    expect(h.switches[0].handle({ t: "chat" })).toBe(false);
    expect(h.switches[0].handle({})).toBe(false);
  });

  it("swallows switch frames before begin and after stop without acting", () => {
    const s = new TransportSwitch({ key: "0", peerKey: "1", policy: () => ({ preferred: "webrtc/1", fallback: true, available: ["webrtc/1"], descriptors: {} }),
      send: vi.fn(), peer: vi.fn(), state: vi.fn(), prepare: vi.fn(), cancel: vi.fn() });
    expect(s.handle({ t: "paired-policy", context: "", policy: {} })).toBe(true);
    expect(s.peerPolicy).toBeNull();
    const h = peers(); h.switches[0].stop();
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { revision: 9, intent: 0, preferred: "iroh/1", fallback: true, available: ["iroh/1"], descriptors: {} } });
    expect(h.switches[0].peerPolicy).toBeNull();
    h.switches[0].changed(); expect(h.queue).toHaveLength(0);
  });

  it("ignores a plan sent to the coordinator, or before any peer policy", () => {
    const h = peers();
    h.switches[0].handle({ t: "paired-switch-plan", context: "ctx", id: "x", revisions: [0, 0], target: "iroh/1" });
    expect(h.prepare[0]).not.toHaveBeenCalled();
    const lone = new TransportSwitch({ key: "1", peerKey: "0", policy: () => ({ preferred: "webrtc/1", fallback: true, available: ["webrtc/1"], descriptors: {} }),
      send: vi.fn(), peer: vi.fn(), state: vi.fn(), prepare: vi.fn(), cancel: vi.fn() });
    lone.begin("ctx", "webrtc/1");
    lone.handle({ t: "paired-switch-plan", context: "ctx", id: "x", revisions: [0, 0], target: "iroh/1" });
    expect(lone.pending).toBeNull();
  });

  it.each([
    ["stale revisions", (f: Record<string, unknown>) => ({ ...f, revisions: [0, 0] })],
    ["no revisions list", (f: Record<string, unknown>) => ({ ...f, revisions: "1:1" })],
    ["another target", (f: Record<string, unknown>) => ({ ...f, target: "hyperdht/1" })],
    ["another id", (f: Record<string, unknown>) => ({ ...f, id: "1:1:iroh/1x" })],
  ])("answers a plan with %s by re-announcing its policy, never preparing", (_, mutate) => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed();
    const plan = h.queue.find(q => q.frame.t === "paired-switch-plan")!.frame;
    h.queue.splice(0);
    h.switches[1].handle({ t: "paired-policy", context: "ctx", policy: { ...h.policies[0], revision: 1, intent: 1 } });
    h.queue.splice(0); h.sent[1].splice(0);
    h.switches[1].handle(mutate(plan));
    expect(h.prepare[1]).not.toHaveBeenCalled();
    expect(h.sent[1].map(f => f.t)).toEqual(["paired-policy"]);
  });

  it("acknowledges a repeated plan again without installing it twice", () => {
    vi.useFakeTimers();
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed();
    const plan = h.queue.find(q => q.frame.t === "paired-switch-plan")!.frame;
    h.flush();
    const installed = h.switches[1].pending;
    vi.advanceTimersByTime(20_000);
    h.sent[1].splice(0);
    h.switches[1].handle(plan);
    expect(h.switches[1].pending).toBe(installed);
    expect(h.sent[1].map(f => f.t)).toEqual(["paired-switch-ready"]);
    // The original deadline still stands: a repeat does not extend it.
    vi.advanceTimersByTime(10_000);
    expect(h.cancel[1]).toHaveBeenCalledOnce();
  });

  it("ignores a ready, go, keep or failed frame for another plan id", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed();
    const id = h.switches[0].pending!.id;
    for (const t of ["paired-switch-ready", "paired-switch-keep", "paired-switch-failed", "paired-switch-go"]) h.switches[0].handle({ t, context: "ctx", id: `${id}-other` });
    expect(h.switches[0].pending?.id).toBe(id);
    expect(h.prepare[0]).not.toHaveBeenCalled();
    expect(h.cancel[0]).not.toHaveBeenCalled();
  });

  it("drops its plan and records the failure when the peer reports one, and does not retry it by itself", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed();
    const id = h.switches[0].pending!.id; h.queue.splice(0);
    h.switches[0].handle({ t: "paired-switch-failed", context: "ctx", id });
    expect(h.switches[0].pending).toBeNull();
    expect(h.cancel[0]).toHaveBeenCalledOnce();
    expect(h.state[0]).toHaveBeenLastCalledWith(expect.stringContaining("failed"));
    // The same revisions are not planned again until something changes.
    h.switches[0].handle({ t: "paired-policy", context: "ctx", policy: { ...h.switches[0].peerPolicy!, revision: h.switches[0].peerPolicy!.revision } });
    expect(h.switches[0].pending).toBeNull();
    h.switches[0].retry();
    expect(h.switches[0].pending?.choices[0]).toBe("iroh/1");
  });

  it("keeps a plan when the peer says keep but the current transport is not one of its choices", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.policies[0].fallback = false; h.switches[0].changed(); h.flush();
    const plan = h.switches[0].pending!;
    expect(plan.choices).toEqual(["iroh/1"]);
    h.switches[0].handle({ t: "paired-switch-keep", context: "ctx", id: plan.id });
    expect(h.switches[0].pending).toBe(plan);
  });

  it("refuses to go ahead on a ready frame when its own policy changed meanwhile, and plans afresh", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed();
    const old = h.switches[0].pending!.id;
    h.queue.splice(0);
    // A local change while the plan waits: the plan stays until the peer answers.
    h.switches[0].changed(false); h.queue.splice(0); h.sent[0].splice(0);
    expect(h.switches[0].pending?.id).toBe(old);
    h.switches[0].handle({ t: "paired-switch-ready", context: "ctx", id: old });
    expect(h.prepare[0]).not.toHaveBeenCalled();
    expect(h.sent[0].map(f => f.t)).toEqual(["paired-policy", "paired-switch-plan"]);
    expect(h.switches[0].pending?.id).not.toBe(old);
  });

  it("follows the go frame only as the follower, and a second ready is not a second dial", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed(); h.flush();
    expect(h.prepare[0]).toHaveBeenCalledOnce();
    const id = h.switches[0].pending!.id;
    h.switches[0].handle({ t: "paired-switch-ready", context: "ctx", id });
    expect(h.prepare[0]).toHaveBeenCalledOnce();
    h.switches[0].handle({ t: "paired-switch-go", context: "ctx", id });
    expect(h.switches[0].pending?.id).toBe(id);
  });
});

describe("transport switch: timeouts and failure", () => {
  it("times out an installed plan after 30 s by default, cancels it and keeps the old channel", () => {
    vi.useFakeTimers();
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.switches[0].changed(); h.flush();
    expect(h.switches[0].pending).not.toBeNull();
    vi.advanceTimersByTime(29_999); expect(h.cancel[0]).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.cancel[0]).toHaveBeenCalledOnce();
    expect(h.state[0]).toHaveBeenLastCalledWith(expect.stringContaining("timed out"));
    expect(h.sent[0].at(-1)).toMatchObject({ t: "paired-switch-failed" });
    h.flush();
    expect(h.switches[1].pending).toBeNull();
    expect(h.cancel[1]).toHaveBeenCalledOnce();
  });

  it("bounds an unanswered follower proposal at 30 s by default", () => {
    vi.useFakeTimers();
    const h = peers(); h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.queue.splice(0);
    vi.advanceTimersByTime(30_000);
    expect(h.state[1]).toHaveBeenLastCalledWith(expect.stringContaining("did not acknowledge"));
  });

  it("reports a local failure to the peer, with no plan id when there is none", () => {
    const h = peers();
    h.switches[0].fail("dial failed");
    expect(h.sent[0].at(-1)).toEqual({ t: "paired-switch-failed", id: undefined, context: "ctx" });
    expect(h.state[0]).toHaveBeenLastCalledWith("dial failed");
    h.switches[0].keep();
    expect(h.sent[0].at(-1)).toEqual({ t: "paired-switch-keep", id: undefined, context: "ctx" });
  });

  it("targets the best-ranked common transport when the winner's preference is not available to the peer", () => {
    const h = peers(); h.policies[0].preferred = "iroh/1"; h.policies[1].available = ["webrtc/1", "hyperdht/1"];
    h.switches[1].changed(false); h.flush();
    h.switches[0].changed(); h.flush();
    // iroh is not on the peer: hyperdht and webrtc tie on rank and the fixed order breaks the tie.
    expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["hyperdht/1", "webrtc/1"] }), true);
    expect(h.prepare[1]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["hyperdht/1", "webrtc/1"] }), false);
  });
});
