import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { PairedSession, type PairedSessionOptions } from "../src/pairedSession";
import { createChannelPair } from "./helpers";

// covers: chat.paired.session, chat.paired.verify, core.capabilities, core.version, core.peer-keys

const active: PairedSession[] = [];
afterEach(() => { active.splice(0).forEach(s => s.stop()); vi.useRealTimers(); vi.restoreAllMocks(); });
const rendezvous: [string, string] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function options(over: Partial<PairedSessionOptions> = {}): PairedSessionOptions {
  return { credentials: { seedB64: createIdentity().seedB64 }, rendezvousKeys: rendezvous, fingerprints: ["a".repeat(64), "b".repeat(64)],
    pinPeer: vi.fn(async () => {}), onState: vi.fn(), onReady: vi.fn(), onApplication: vi.fn(), onFailure: vi.fn(), ...over };
}

/** One session under test on `mine`; the test speaks for the peer on `theirs` and sees what it sends. */
function lone(over: Partial<PairedSessionOptions> = {}) {
  const [mine, theirs] = createChannelPair();
  const sent: string[] = [];
  theirs.onMessage = data => { if (typeof data === "string") sent.push(data); };
  const opts = options(over);
  const s = new PairedSession(mine, opts);
  active.push(s); s.start();
  /** Injects straight into the session's receive path, as the data channel would. */
  const inject = (data: string | Uint8Array) => mine.onMessage!(data);
  return { s, mine, theirs, sent, opts, inject };
}

/** Two sessions whose frames pass through `tamper` on the way from B to A. */
function pair(a: Partial<PairedSessionOptions> = {}, b: Partial<PairedSessionOptions> = {},
  tamper: (frame: string, send: (data: string) => void) => void = (frame, send) => send(frame)) {
  const [ac, bc] = createChannelPair();
  const original = bc.send.bind(bc);
  bc.send = data => typeof data === "string" && data.startsWith('{"t":"pair-') ? tamper(data, original) : original(data);
  const oa = options(a), ob = options(b);
  const sa = new PairedSession(ac, oa), sb = new PairedSession(bc, ob);
  active.push(sa, sb); sa.start(); sb.start();
  return { a: sa, b: sb, ac, bc, oa, ob };
}
const offer = (over: Record<string, unknown> = {}) => JSON.stringify({ t: "pair-offer", versions: [1], transports: ["webrtc/1"],
  capabilities: ["chat/1"], key: createIdentity().pubKeyZ32, nonce: "a".repeat(43), ...over });
const failedWith = async (s: PairedSession, pattern: RegExp) => {
  await vi.waitFor(() => expect(s.state.status).toBe("error"));
  expect(s.state.error).toMatch(pattern);
};

describe("paired session: refusing to start on a bad binding", () => {
  const hex = (c: string, n = 64) => c.repeat(n);
  it.each<[string, Partial<PairedSessionOptions>]>([
    ["no fingerprints", { fingerprints: undefined }],
    ["an upper-case fingerprint", { fingerprints: [hex("A"), hex("b")] }],
    ["a short fingerprint", { fingerprints: [hex("a", 63), hex("b")] }],
    ["a HyperDHT binding with a 32-byte context", { binding: { transport: "hyperdht/1", context: hex("a"), identities: [hex("b"), hex("c")] }, transports: ["hyperdht/1"] }],
    ["an Iroh binding with a 64-byte context", { binding: { transport: "iroh/1", context: hex("a", 128), identities: [hex("b"), hex("c")] }, transports: ["iroh/1"] }],
    ["a binding naming the same identity twice", { binding: { transport: "iroh/1", context: hex("a"), identities: [hex("b"), hex("b")] }, transports: ["iroh/1"] }],
    ["a binding with a malformed identity", { binding: { transport: "iroh/1", context: hex("a"), identities: [hex("b"), "c"] }, transports: ["iroh/1"] }],
    ["a transport list without the one in use", { transports: ["iroh/1"] }],
    ["a malformed rendezvous key", { rendezvousKeys: [rendezvous[0], "not-a-key"] }],
  ])("fails before sending anything with %s", async (_, over) => {
    const h = lone(over);
    expect(h.s.state).toMatchObject({ status: "error", error: expect.stringMatching(/Invalid connection binding/) });
    expect(h.opts.onFailure).toHaveBeenCalledOnce();
    await tick();
    expect(h.sent).toEqual([]);
  });

  it("pairs over a HyperDHT binding with its 64-byte handshake hash", async () => {
    const binding = { transport: "hyperdht/1" as const, context: "a".repeat(128), identities: ["b".repeat(64), "c".repeat(64)] as [string, string] };
    const p = pair({ binding, transports: ["hyperdht/1"], trustOnFirstUse: true }, { binding, transports: ["hyperdht/1"], trustOnFirstUse: true });
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
    expect(p.a.state.transport).toBe("hyperdht/1");
  });
});

describe("paired session: receive limits", () => {
  it("fails on a frame over 60 KiB, text or binary", async () => {
    const text = lone(); text.inject("x".repeat(60 * 1024 + 1));
    expect(text.s.state.error).toMatch(/receive limit/);
    const binary = lone(); binary.inject(new Uint8Array(60 * 1024 + 1));
    expect(binary.s.state.error).toMatch(/receive limit/);
    const edge = lone(); edge.inject(new Uint8Array(60 * 1024)); await tick();
    expect(edge.s.state.status).toBe("negotiating");
  });

  it("fails when more than 64 frames wait unprocessed", async () => {
    const h = lone();
    for (let i = 0; i < 64; i++) h.inject(`frame ${i}`);
    expect(h.s.state.status).toBe("negotiating");
    h.inject("one too many");
    expect(h.s.state.error).toMatch(/receive limit/);
  });

  it("refuses a negotiation frame one byte over 4096, and reads one at the limit", async () => {
    const at = lone(), frame = offer();
    at.inject(frame + " ".repeat(4096 - frame.length)); await tick(); await tick();
    expect(at.s.state.status).toBe("negotiating");
    await vi.waitFor(() => expect(at.sent.some(f => f.startsWith('{"t":"pair-proof"'))).toBe(true));
    const over = lone();
    over.inject(frame + " ".repeat(4097 - frame.length));
    await failedWith(over.s, /Negotiation message too large/);
  });

  it("fails on a negotiation frame that is not JSON, or of an unknown kind", async () => {
    const broken = lone(); broken.inject('{"t":"pair-offer",');
    await failedWith(broken.s, /Invalid session negotiation/);
    const unknown = lone(); unknown.inject(JSON.stringify({ t: "pair-hello" }));
    await failedWith(unknown.s, /Unsupported session message/);
  });

  it("ignores everything after stop, including frames already queued", async () => {
    const p = pair({ trustOnFirstUse: true }, { trustOnFirstUse: true });
    await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
    p.ac.onMessage!("queued before stop");
    p.a.stop();
    p.ac.onMessage!("after stop");
    p.ac.onMessage!("x".repeat(70 * 1024));
    await tick();
    expect(p.oa.onApplication).not.toHaveBeenCalled();
    expect(p.a.state.status).toBe("ready");
    expect(p.oa.onFailure).not.toHaveBeenCalled();
  });

  it("hands binary application data through once ready", async () => {
    const p = pair({ trustOnFirstUse: true }, { trustOnFirstUse: true });
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
    p.bc.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(p.oa.onApplication).toHaveBeenCalledWith(new Uint8Array([1, 2, 3])));
  });

  it("gives up after three minutes without authentication", async () => {
    vi.useFakeTimers();
    const h = lone();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(h.s.state.status).toBe("negotiating");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.s.state.error).toMatch(/did not finish authentication/);
    expect(h.opts.onFailure).toHaveBeenCalledOnce();
  });
});

describe("paired session: offers a peer may not make", () => {
  it.each<[string, Record<string, unknown>]>([
    ["no versions", { versions: [] }],
    ["nine versions", { versions: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    ["version zero", { versions: [1, 0] }],
    ["a string version", { versions: ["1"] }],
    ["a duplicated version", { versions: [1, 1] }],
    ["versions that are not a list", { versions: 1 }],
    ["no transports", { transports: [] }],
    ["a transport with capitals", { transports: ["WebRTC/1"] }],
    ["a duplicated transport", { transports: ["webrtc/1", "webrtc/1"] }],
    ["nine transports", { transports: ["webrtc/1", ...Array.from({ length: 8 }, (_, i) => `t${i}/1`)] }],
    ["a transport over 40 characters", { transports: ["webrtc/1", "x".repeat(41)] }],
    ["33 capabilities", { capabilities: ["chat/1", ...Array.from({ length: 32 }, (_, i) => `cap-${i}/1`)] }],
    ["a numeric capability", { capabilities: ["chat/1", 7] }],
    ["a numeric key", { key: 7 }],
    ["a key outside z-base-32", { key: "l".repeat(52) }],
    ["a short nonce", { nonce: "a".repeat(42) }],
    ["a numeric nonce", { nonce: 7 }],
  ])("fails on an offer with %s", async (_, over) => {
    const h = lone(); h.inject(offer(over));
    await failedWith(h.s, /Invalid participation key or offer/);
    expect(h.sent.some(f => f.includes("pair-proof"))).toBe(false);
  });

  it("accepts exactly 32 capabilities and 8 transports", async () => {
    const h = lone();
    h.inject(offer({ capabilities: ["chat/1", ...Array.from({ length: 31 }, (_, i) => `cap-${i}/1`)],
      transports: ["webrtc/1", ...Array.from({ length: 7 }, (_, i) => `t${i}/1`)] }));
    await vi.waitFor(() => expect(h.sent.some(f => f.startsWith('{"t":"pair-proof"'))).toBe(true));
  });

  it("says in its offer that it answers pings, outside the capabilities and the transcript", async () => {
    const h = lone();
    const own = JSON.parse(await vi.waitFor(() => { const f = h.sent.find(x => x.includes("pair-offer")); expect(f).toBeDefined(); return f!; }));
    expect(own.extensions).toEqual(["ping/1"]);
    expect(own.capabilities).not.toContain("ping/1");
  });

  it.each<[string, unknown, boolean]>([
    ["says it answers pings", ["ping/1"], true],
    ["says only something else", ["later/1"], false],
    ["says nothing (an older app)", undefined, false],
    ["sends a malformed list", "ping/1", false],
    ["sends a list with a bad entry", ["ping/1", 7], false],
  ])("reads whether a peer that %s answers pings, and never fails the offer over it", async (_, extensions, answers) => {
    const { a, b } = pair({ trustOnFirstUse: true }, { trustOnFirstUse: true }, (frame, send) => {
      if (!frame.startsWith('{"t":"pair-offer"')) return send(frame);
      const { extensions: __, ...rest } = JSON.parse(frame) as Record<string, unknown>;
      send(JSON.stringify(extensions === undefined ? rest : { ...rest, extensions }));
    });
    await vi.waitFor(() => { expect(a.state.status).toBe("ready"); expect(b.state.status).toBe("ready"); });
    expect(a.peerAnswersPings).toBe(answers);
    expect(b.peerAnswersPings).toBe(true);
  });

  it("fails on its own key reflected back as the peer's", async () => {
    const h = lone();
    const own = JSON.parse(await vi.waitFor(() => { const f = h.sent.find(x => x.includes("pair-offer")); expect(f).toBeDefined(); return f!; }));
    h.inject(JSON.stringify({ ...own, nonce: "b".repeat(43) }));
    await failedWith(h.s, /Invalid participation key/);
  });

  it("fails on an offer without chat, or without the transport in use", async () => {
    const chat = lone(); chat.inject(offer({ capabilities: ["files/2"] }));
    await failedWith(chat.s, /No compatible paired chat profile/);
    const transport = lone(); transport.inject(offer({ transports: ["iroh/1"] }));
    await failedWith(transport.s, /No compatible/);
  });

  it("ignores the same offer twice but fails when the peer changes it", async () => {
    const h = lone(), key = createIdentity().pubKeyZ32;
    h.inject(offer({ key })); h.inject(offer({ key }));
    await vi.waitFor(() => expect(h.sent.filter(f => f.startsWith('{"t":"pair-proof"'))).toHaveLength(1));
    expect(h.s.state.status).toBe("negotiating");
    h.inject(offer({ key, capabilities: ["chat/1", "files/2"] }));
    await failedWith(h.s, /changed its negotiation offer/);
  });

  it("fails when the best common transport is not the one in use and either side refuses fallback", async () => {
    const both = ["iroh/1", "webrtc/1"] as const;
    const strict = pair({ transports: [...both] }, { transports: [...both], allowFallback: true });
    await failedWith(strict.a, /fallback policy/);
    await failedWith(strict.b, /fallback policy/);
  });

  it("pairs on the fallback transport when both allow it, reporting the preferred one", async () => {
    const both = { transports: ["iroh/1", "webrtc/1"] as ("iroh/1" | "webrtc/1")[], allowFallback: true, trustOnFirstUse: true, transportSwitchSupport: true };
    const p = pair(both, both);
    expect(p.a.peerTransports).toEqual([]);
    expect(p.a.peerAllowsFallback).toBe(false);
    expect(p.a.peerTransportSwitchSupport).toBe(false);
    expect(p.a.proofSession).toBe("");
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
    expect(p.a.state).toMatchObject({ transport: "webrtc/1", preferred: "iroh/1" });
    expect(p.a.peerTransports).toEqual(["iroh/1", "webrtc/1"]);
    expect(p.a.peerAllowsFallback).toBe(true);
    expect(p.a.peerTransportSwitchSupport).toBe(true);
    expect(p.a.proofSession).toMatch(/^[a-f0-9]{64}$/);
    expect(p.a.proofSession).toBe(p.b.proofSession);
  });
});

describe("paired session: proofs and confirmations out of place", () => {
  it("fails on a proof that arrives before any offer", async () => {
    const h = lone(); h.inject(JSON.stringify({ t: "pair-proof", sig: "A".repeat(86) }));
    await failedWith(h.s, /could not authenticate/);
  });

  it.each([["a numeric signature", 7], ["a short signature", "A".repeat(85)], ["a signature that does not verify", "A".repeat(86)]])(
    "fails on a proof with %s", async (_, sig) => {
      const p = pair({}, {}, (frame, send) => send(frame.startsWith('{"t":"pair-proof"') ? JSON.stringify({ t: "pair-proof", sig }) : frame));
      await failedWith(p.a, /could not authenticate/);
      expect(p.oa.pinPeer).not.toHaveBeenCalled();
    });

  it("treats a repeated proof as the same proof", async () => {
    const p = pair({ trustOnFirstUse: true }, { trustOnFirstUse: true }, (frame, send) => { send(frame); if (frame.startsWith('{"t":"pair-proof"')) send(frame); });
    await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
    expect(p.oa.pinPeer).toHaveBeenCalledOnce();
    expect(p.oa.onReady).toHaveBeenCalledOnce();
  });

  it("fails on a readiness frame before a proof, or for another session", async () => {
    const early = pair({}, {}, (frame, send) => {
      if (frame.startsWith('{"t":"pair-offer"')) { send(frame); send(JSON.stringify({ t: "pair-ready", context: "" })); } else send(frame);
    });
    await failedWith(early.a, /Invalid session confirmation/);
    const other = pair({ trustOnFirstUse: true }, { trustOnFirstUse: true },
      (frame, send) => send(frame.startsWith('{"t":"pair-ready"') ? JSON.stringify({ t: "pair-ready", context: "f".repeat(64) }) : frame));
    await failedWith(other.a, /Invalid session confirmation/);
    expect(other.oa.onReady).not.toHaveBeenCalled();
  });

  it("refuses to confirm before there is an authenticated peer, or after stop", async () => {
    const h = lone();
    await expect(h.s.confirm("anything")).rejects.toThrow(/No authenticated peer/);
    const p = pair();
    await vi.waitFor(() => expect(p.a.state.status).toBe("confirm"));
    const code = p.a.state.code!;
    p.a.stop();
    await expect(p.a.confirm(code)).rejects.toThrow(/No authenticated peer/);
    expect(p.oa.pinPeer).not.toHaveBeenCalled();
  });

  it("allows no payment method, and no identity proofs, before the session is ready", async () => {
    const all = { paymentsSupport: true, arkPaymentsSupport: true, identitySupport: true };
    const p = pair(all, all);
    await vi.waitFor(() => expect(p.a.state.status).toBe("confirm"));
    for (const m of ["cashu", "lightning", "arkade", "bitcoin"] as const) {
      expect(p.a.peerAllowsPayment(m)).toBe(false);
      expect(p.a.allowsPayment(m)).toBe(false);
    }
    expect(p.a.supports("payments/1")).toBe(false);
    expect(p.a.identitySupport).toBe(false);
  });

  it("refuses a peer without signed signals once they were required, without pinning it", async () => {
    const b = createIdentity();
    const [ac, bc] = createChannelPair();
    const oa = options({ credentials: { seedB64: createIdentity().seedB64, peerKey: b.pubKeyZ32, requireSignedSignals: true } });
    const sa = new PairedSession(ac, oa), sb = new PairedSession(bc, options({ credentials: { seedB64: b.seedB64 } }));
    (sb as unknown as { offer: { capabilities: string[] } }).offer.capabilities = ["chat/1"];
    active.push(sa, sb); sa.start(); sb.start();
    await failedWith(sa, /Could not durably save/);
    expect(oa.pinPeer).not.toHaveBeenCalled();
    expect(oa.onReady).not.toHaveBeenCalled();
  });

  it("raises no failure when a pin fails after the session was stopped", async () => {
    let reject!: (e: Error) => void;
    const p = pair({ trustOnFirstUse: true, pinPeer: () => new Promise<void>((_, r) => { reject = r; }) }, { trustOnFirstUse: true });
    await vi.waitFor(() => expect(reject).toBeDefined());
    p.a.stop(); reject(new Error("disk gone")); await tick();
    expect(p.oa.onFailure).not.toHaveBeenCalled();
    expect(p.a.state.status).not.toBe("error");
  });

  it("sends no proof when stopped while hashing the transcript", async () => {
    let release!: (v: ArrayBuffer) => void;
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>(r => { release = r; }));
    const h = lone(); h.inject(offer());
    await vi.waitFor(() => expect(digest).toHaveBeenCalled());
    h.s.stop(); release(new ArrayBuffer(32)); await tick();
    expect(h.sent.some(f => f.includes("pair-proof"))).toBe(false);
  });
});
