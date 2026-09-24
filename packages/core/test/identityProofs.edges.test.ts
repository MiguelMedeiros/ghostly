import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import {
  IDENTITY_CLOCK_SKEW, IDENTITY_MAX_EVIDENCE, IdentityExchange, boundVerifiedIdentity, emptyIdentityLedger, identityStatement, newIdentityBinding,
  receivedIdentityStatus, signIdentityPresentation, verifyIdentityPresentation,
  type IdentityLedger, type IdentityStatement, type LocalIdentityProof, type ReceivedIdentity, type VerifiedIdentity,
} from "../src/identityProofs";

// covers: proofs.binding, proofs.share, proofs.withdraw, proofs.expiry

const NOW = 1_800_000_000;
const SUBJECT = "npub-test-subject";

afterEach(() => { vi.useRealTimers(); });

describe("bounding what a provider returns", () => {
  it("refuses a missing, malformed or unexplained result", () => {
    for (const bad of [null, { subject: "a b", source: "x" }, { subject: 5, source: "x" }, { subject: "", source: "x" }])
      expect(() => boundVerifiedIdentity(bad as unknown as VerifiedIdentity)).toThrow("Provider returned an invalid subject");
    for (const source of [undefined, "", "   ", "\u0000\u001f\u202e", 42])
      expect(() => boundVerifiedIdentity({ subject: "alice", source } as unknown as VerifiedIdentity)).toThrow("Provider did not say how it verified");
    for (const expiresAt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "1"])
      expect(() => boundVerifiedIdentity({ subject: "alice", source: "s", expiresAt } as unknown as VerifiedIdentity)).toThrow("Provider returned an invalid expiry");
  });

  it("strips control and bidi-override characters, bounds lengths, and drops unknown fields", () => {
    const out = boundVerifiedIdentity({ subject: "alice", source: `\u202eDNS\u0007 ${"s".repeat(200)}`, attester: `  ${"a".repeat(300)}`, evil: "<script>" } as unknown as VerifiedIdentity);
    expect(out.source.startsWith("DNS s")).toBe(true);
    expect(out.source).toHaveLength(120);
    expect(out.attester).toHaveLength(253);
    expect(out).not.toHaveProperty("evil");
    expect(boundVerifiedIdentity({ subject: "alice", source: "s", attester: "\u200e\u2066" })).toEqual({ subject: "alice", source: "s" });
  });

  it("keeps only an inline PNG/JPEG avatar and an https profile link without credentials", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const display = (d: Record<string, unknown>) => boundVerifiedIdentity({ subject: "alice", source: "s", display: { source: "kind-0", fetchedAt: 5, ...d } }).display!;
    expect(display({ avatar: png, url: "https://example.com/alice", name: " Alice\u0000 " })).toEqual({ source: "kind-0", fetchedAt: 5, avatar: png, url: "https://example.com/alice", name: "Alice" });
    for (const avatar of ["data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/a.png", `data:image/png;base64,${"A".repeat(48 * 1024)}`, "data:image/png;base64,<>", 7])
      expect(display({ avatar })).not.toHaveProperty("avatar");
    for (const url of ["http://example.com/", "https://user:pw@example.com/", "javascript:alert(1)", "not a url", `https://example.com/${"x".repeat(520)}`, 7])
      expect(display({ url })).not.toHaveProperty("url");
    expect(display({ name: "\u202e" })).not.toHaveProperty("name");
    expect(display({ name: "n".repeat(100) }).name).toHaveLength(64);
  });

  it("labels display data with no source as self-described, dated now", () => {
    vi.useFakeTimers({ now: 1_900_000_000_500 });
    const out = boundVerifiedIdentity({ subject: "alice", source: "s", display: { fetchedAt: -3 } as never });
    expect(out.display).toEqual({ source: "Self-described", fetchedAt: 1_900_000_000 });
  });
});

describe("presentation signatures", () => {
  it("say no, never throw, for a malformed signature or key", () => {
    const { binding, seed } = newIdentityBinding({ provider: "test", subject: SUBJECT, validitySeconds: 60, now: NOW });
    const scope = { subject: createIdentity().pubKeyZ32, audience: createIdentity().pubKeyZ32, context: "a".repeat(64), session: "b".repeat(64) };
    const id = identityStatement(binding).id;
    const sig = signIdentityPresentation(seed, id, scope, "N".repeat(43), NOW);
    expect(verifyIdentityPresentation(binding.key, sig, id, scope, "N".repeat(43), NOW)).toBe(true);
    expect(verifyIdentityPresentation(binding.key, sig, id, scope, "N".repeat(43), NOW + 1)).toBe(false);
    for (const bad of [undefined, 42, sig.slice(1), `${sig}A`, sig.replace(/^./, "+")])
      expect(verifyIdentityPresentation(binding.key, bad as string, id, scope, "N".repeat(43), NOW)).toBe(false);
    expect(verifyIdentityPresentation("short", sig, id, scope, "N".repeat(43), NOW)).toBe(false);
  });
});

describe("what the verifier shows", () => {
  const record = (over: Partial<ReceivedIdentity> = {}): ReceivedIdentity => {
    const { binding } = newIdentityBinding({ provider: "test", subject: SUBJECT, validitySeconds: 1000, now: NOW });
    return { id: "x", binding, evidence: {}, verified: { subject: SUBJECT, source: "s" }, presenter: "p", audience: "a", context: "c", verifiedAt: NOW, checkedAt: NOW, status: "verified", ...over };
  };
  it("expires at the earlier of the binding and the evidence, and a changed key wins over everything", () => {
    expect(receivedIdentityStatus(record(), "p", "a", NOW + 999)).toBe("verified");
    expect(receivedIdentityStatus(record(), "p", "a", NOW + 1000)).toBe("expired");
    expect(receivedIdentityStatus(record({ verified: { subject: SUBJECT, source: "s", expiresAt: NOW + 10 } }), "p", "a", NOW + 10)).toBe("expired");
    expect(receivedIdentityStatus(record({ status: "unconfirmed" }), "p", "a", NOW)).toBe("unconfirmed");
    expect(receivedIdentityStatus(record({ status: "unconfirmed" }), "p", "a", NOW + 5000)).toBe("expired");
    expect(receivedIdentityStatus(record({ status: "revoked" }), "p", "a", NOW + 5000)).toBe("revoked");
    expect(receivedIdentityStatus(record({ status: "withdrawn" }), "p", undefined, NOW)).toBe("previous-key");
  });
});

// ---------------------------------------------------------------------------------------------
// The exchange between two contacts

type Frame = Record<string, unknown>;
function world() {
  let now = NOW;
  const ids = { alice: createIdentity().pubKeyZ32, bob: createIdentity().pubKeyZ32 };
  const ledgers = { alice: emptyIdentityLedger(), bob: emptyIdentityLedger() } as Record<"alice" | "bob", IdentityLedger>;
  const proofs = new Map<string, LocalIdentityProof>();
  const frames: { from: string; frame: Frame }[] = [];
  const errors: string[] = [];
  const state = { online: true, revoked: new Set<string>(), revokedFails: false, subject: SUBJECT, verifiedExpiry: undefined as number | undefined, display: undefined as VerifiedIdentity["display"] };
  /** A provider whose evidence is a commitment to the statement id. */
  const verify = vi.fn(async (s: IdentityStatement, evidence: unknown): Promise<VerifiedIdentity> => {
    if ((evidence as { for?: string })?.for !== s.id) throw new Error("Evidence is for another statement");
    return { subject: state.subject, source: "Test", ...(state.verifiedExpiry ? { expiresAt: state.verifiedExpiry } : {}), ...(state.display ? { display: state.display } : {}) };
  });
  const peers = {} as Record<"alice" | "bob", IdentityExchange>;
  for (const [me, them] of [["alice", "bob"], ["bob", "alice"]] as const) {
    peers[me] = new IdentityExchange({
      scope: () => ({ subject: ids[me], audience: ids[them], context: "a".repeat(64), session: "s".repeat(64) }),
      send: frame => { frames.push({ from: me, frame: structuredClone(frame) as Frame }); if (state.online) queueMicrotask(() => void peers[them].receive(structuredClone(frame) as Frame)); },
      storage: { read: () => ledgers[me], update: async change => { ledgers[me] = change(structuredClone(ledgers[me])); } },
      providers: () => ["test"],
      localProof: id => proofs.get(id),
      verify, now: () => now, onError: e => errors.push(e),
      revoked: async st => { if (state.revokedFails) throw new Error("resolver down"); return state.revoked.has(st.id); },
    });
  }
  const addProof = (options: { evidence?: unknown; issuedAt?: number; validity?: number; provider?: string } = {}) => {
    const { binding, seed } = newIdentityBinding({ provider: options.provider ?? "test", subject: SUBJECT, validitySeconds: options.validity ?? 86_400, now: options.issuedAt ?? now });
    const statement = identityStatement(binding);
    proofs.set(statement.id, { statement, evidence: options.evidence ?? { for: statement.id }, seed });
    return statement.id;
  };
  const sent = (t: string) => frames.filter(f => f.frame.t === t);
  return { ids, ledgers, proofs, frames, errors, state, verify, peers, addProof, sent, advance: (s: number) => { now += s; }, now: () => now };
}
async function shareAndSettle(w: ReturnType<typeof world>, id: string) {
  await w.peers.alice.share(id, true);
  await vi.waitFor(() => expect(["accepted", "rejected"]).toContain(w.ledgers.alice.shared.find(s => s.id === id)?.status));
}

describe("hello and reconnect", () => {
  it("learns the contact's providers from its hello, filtered and bounded, and forgets them on stop", async () => {
    const w = world();
    expect(w.peers.alice.contactProviders).toBeUndefined();
    await w.peers.alice.receive({ t: "idp-hello", providers: ["test", "Bad Name", 7, "dns"] });
    expect(w.peers.alice.contactProviders).toEqual(["test", "dns"]);
    await w.peers.alice.receive({ t: "idp-hello", providers: Array(65).fill("test") });
    await w.peers.alice.receive({ t: "idp-hello", providers: "test" });
    expect(w.peers.alice.contactProviders).toEqual(["test", "dns"]);
    w.peers.alice.stop();
    expect(w.peers.alice.contactProviders).toBeUndefined();
  });

  it("on ready, says hello, asks again for queued and pending shares, and repeats pending withdrawals", async () => {
    const w = world();
    w.state.online = false;
    const queued = w.addProof(), withdrawing = w.addProof({ provider: "other" });
    await w.peers.alice.share(queued, false);
    w.ledgers.alice.shared.push({ id: withdrawing, provider: "other", subject: SUBJECT, status: "withdrawal-pending", at: NOW },
      { id: "d".repeat(64), provider: "x", subject: SUBJECT, status: "accepted", at: NOW });
    expect(w.frames).toEqual([]);
    w.peers.alice.ready();
    expect(w.frames.map(f => f.frame)).toEqual([
      { t: "idp-hello", providers: ["test"] }, { t: "idp-request", id: queued, provider: "test" }, { t: "idp-withdraw", id: withdrawing },
    ]);
  });
});

describe("sharing", () => {
  it("refuses to share a proof that is no longer in the profile", async () => {
    const w = world();
    await expect(w.peers.alice.share("f".repeat(64), true)).rejects.toThrow("That identity is no longer in your profile");
    expect(w.frames).toEqual([]);
  });

  it("marks the share rejected when the proof is removed before the challenge arrives", async () => {
    const w = world();
    const id = w.addProof();
    w.state.online = false;
    await w.peers.alice.share(id, true);
    w.proofs.delete(id);
    await w.peers.alice.receive({ t: "idp-challenge", id, nonce: "N".repeat(43), issuedAt: NOW });
    expect(w.ledgers.alice.shared[0]).toMatchObject({ status: "rejected", error: "That identity is no longer in your profile" });
    expect(w.sent("idp-present")).toEqual([]);
  });

  it("answers a challenge only once, and only for a share still waiting", async () => {
    const w = world();
    const id = w.addProof();
    w.state.online = false;
    await w.peers.alice.share(id, true);
    const challenge = { t: "idp-challenge", id, nonce: "N".repeat(43), issuedAt: NOW };
    for (const bad of [{ ...challenge, nonce: "short" }, { ...challenge, issuedAt: 0 }, { ...challenge, id: "nothex" }]) await w.peers.alice.receive(bad);
    expect(w.sent("idp-present")).toEqual([]);
    await w.peers.alice.receive(challenge);
    await w.peers.alice.receive(challenge);
    expect(w.sent("idp-present")).toHaveLength(1);
    // Asked again, but meanwhile the share was settled elsewhere: a challenge for it is ignored.
    w.peers.alice.ready();
    w.ledgers.alice.shared[0].status = "accepted";
    await w.peers.alice.receive(challenge);
    expect(w.sent("idp-present")).toHaveLength(1);
  });

  it("reports evidence too large for a frame instead of sending it", async () => {
    const w = world();
    const id = w.addProof({ evidence: { pad: "x".repeat(40_000) } });
    await w.peers.alice.share(id, true);
    await vi.waitFor(() => expect(w.errors).toContain("Identity proof too large"));
    expect(w.sent("idp-present")).toEqual([]);
  });

  it("reads the verifier's result: accepted, or rejected with a cleaned reason or a default one", async () => {
    const w = world();
    w.state.online = false;
    const ids = [w.addProof(), w.addProof(), w.addProof()];
    for (const id of ids) { await w.peers.alice.share(id, true); await w.peers.alice.receive({ t: "idp-challenge", id, nonce: "N".repeat(43), issuedAt: NOW }); }
    await w.peers.alice.receive({ t: "idp-result", id: ids[0], ok: true, error: "ignored" });
    await w.peers.alice.receive({ t: "idp-result", id: ids[1], ok: false, error: "\u202eNope\u0000" });
    await w.peers.alice.receive({ t: "idp-result", id: ids[2], ok: "yes" });
    expect(w.ledgers.alice.shared.map(s => [s.status, s.error])).toEqual([["accepted", undefined], ["rejected", "Nope"], ["rejected", "Your contact could not verify it"]]);
    // A late result for a settled share changes nothing.
    await w.peers.alice.receive({ t: "idp-result", id: ids[1], ok: true });
    expect(w.ledgers.alice.shared[1].status).toBe("rejected");
    await w.peers.alice.receive({ t: "idp-result", id: "nothex", ok: true });
  });
});

describe("withdrawing", () => {
  it("does nothing for an unknown or already withdrawn share", async () => {
    const w = world();
    await w.peers.alice.withdraw("f".repeat(64), true);
    w.ledgers.alice.shared.push({ id: "e".repeat(64), provider: "test", subject: SUBJECT, status: "withdrawn", at: NOW });
    await w.peers.alice.withdraw("e".repeat(64), true);
    expect(w.frames).toEqual([]);
    expect(w.ledgers.alice.shared).toHaveLength(1);
  });

  it("while offline, marks the withdrawal pending and says it on the next ready", async () => {
    const w = world();
    const id = w.addProof();
    await shareAndSettle(w, id);
    w.state.online = false;
    await w.peers.alice.withdraw(id, false);
    expect(w.ledgers.alice.shared[0].status).toBe("withdrawal-pending");
    expect(w.sent("idp-withdraw")).toEqual([]);
    w.state.online = true;
    w.peers.alice.ready();
    await vi.waitFor(() => expect(w.ledgers.alice.shared[0].status).toBe("withdrawn"));
    expect(w.ledgers.bob.received[0].status).toBe("withdrawn");
  });

  it("while connected, tells the contact at once", async () => {
    const w = world();
    const id = w.addProof();
    await shareAndSettle(w, id);
    await w.peers.alice.withdraw(id, true);
    expect(w.sent("idp-withdraw").map(f => f.frame)).toEqual([{ t: "idp-withdraw", id }]);
    await vi.waitFor(() => expect(w.ledgers.alice.shared[0].status).toBe("withdrawn"));
  });

  it("acknowledges only well-formed withdrawals, and a stray acknowledgement changes nothing", async () => {
    const w = world();
    w.state.online = false;
    await w.peers.bob.receive({ t: "idp-withdraw", id: "../x" });
    expect(w.frames).toEqual([]);
    w.ledgers.alice.shared.push({ id: "e".repeat(64), provider: "test", subject: SUBJECT, status: "accepted", at: NOW });
    await w.peers.alice.receive({ t: "idp-withdrawn", id: "e".repeat(64) });
    await w.peers.alice.receive({ t: "idp-withdrawn" });
    expect(w.ledgers.alice.shared[0].status).toBe("accepted");
  });
});

describe("verifying a presentation", () => {
  /** Alice asks, Bob challenges, Alice answers; returns the present frame without delivering it. */
  async function present(w: ReturnType<typeof world>, id: string) {
    w.state.online = false;
    await w.peers.alice.share(id, true);
    await w.peers.bob.receive(w.sent("idp-request").at(-1)!.frame);
    await w.peers.alice.receive(w.sent("idp-challenge").at(-1)!.frame);
    return w.sent("idp-present").at(-1)!.frame;
  }
  const result = (w: ReturnType<typeof world>) => w.sent("idp-result").at(-1)?.frame;

  it("ignores a request with a malformed id, and answers an unverifiable provider without a challenge", async () => {
    const w = world();
    w.state.online = false;
    await w.peers.bob.receive({ t: "idp-request", id: "short", provider: "test" });
    expect(w.frames).toEqual([]);
    await w.peers.bob.receive({ t: "idp-request", id: "f".repeat(64), provider: 5 });
    expect(w.frames.map(f => f.frame)).toEqual([{ t: "idp-result", id: "f".repeat(64), ok: false, error: expect.stringMatching(/cannot verify/) }]);
    expect(w.ledgers.bob.challenges).toEqual([]);
  });

  it("drops a malformed present silently, keeping the challenge", async () => {
    const w = world();
    const frame = await present(w, w.addProof());
    const count = w.frames.length;
    for (const bad of [{ ...frame, nonce: 5 }, { ...frame, nonce: "short" }, { ...frame, issuedAt: -1 }, { ...frame, binding: { ...(frame.binding as object), v: 2 } }, { ...frame, binding: null }])
      await w.peers.bob.receive(bad);
    expect(w.frames).toHaveLength(count);
    expect(w.errors).toEqual([]);
    expect(w.ledgers.bob.challenges).toHaveLength(1);
  });

  it("refuses oversized evidence, consuming the challenge", async () => {
    const w = world();
    const id = w.addProof({ evidence: { pad: "x".repeat(IDENTITY_MAX_EVIDENCE) } });
    await w.peers.bob.receive(await present(w, id));
    expect(result(w)).toEqual({ t: "idp-result", id, ok: false, error: "Evidence too large" });
    expect(w.ledgers.bob.challenges).toEqual([]);
    expect(w.verify).not.toHaveBeenCalled();
  });

  it("refuses a proof dated beyond the tolerated clock skew, and accepts one just inside it", async () => {
    const w = world();
    const future = w.addProof({ issuedAt: NOW + IDENTITY_CLOCK_SKEW + 1 });
    await w.peers.bob.receive(await present(w, future));
    expect(result(w)).toMatchObject({ ok: false, error: "The proof is dated in the future" });
    const edge = w.addProof({ issuedAt: NOW + IDENTITY_CLOCK_SKEW });
    await w.peers.bob.receive(await present(w, edge));
    expect(result(w)).toMatchObject({ id: edge, ok: true });
  });

  it("refuses a proof whose evidence expired before its binding", async () => {
    const w = world();
    w.state.verifiedExpiry = NOW;
    await w.peers.bob.receive(await present(w, w.addProof()));
    expect(result(w)).toMatchObject({ ok: false, error: "The proof has expired" });
    expect(w.ledgers.bob.received).toEqual([]);
  });

  it("refuses a present without evidence, and reports a provider that throws something odd", async () => {
    const w = world();
    const frame = await present(w, w.addProof());
    const { evidence: _evidence, ...bare } = frame;
    await w.peers.bob.receive(bare);
    expect(result(w)).toMatchObject({ ok: false, error: "Evidence is for another statement" });
    w.verify.mockImplementationOnce(async () => { throw "   "; });
    await w.peers.bob.receive(await present(w, w.addProof()));
    expect(result(w)).toMatchObject({ ok: false, error: "Invalid proof" });
  });

  it("does not refuse a proof because the revocation lookup failed", async () => {
    const w = world();
    w.state.revokedFails = true;
    const id = w.addProof();
    await w.peers.bob.receive(await present(w, id));
    expect(result(w)).toMatchObject({ id, ok: true });
  });

  it("refuses evidence the provider rejects, and a presentation signed for another nonce", async () => {
    const w = world();
    const id = w.addProof({ evidence: { for: "someone else" } });
    await w.peers.bob.receive(await present(w, id));
    expect(result(w)).toMatchObject({ ok: false, error: "Evidence is for another statement" });
    const good = await present(w, w.addProof());
    const other = await present(w, w.addProof());
    // The signature over one challenge presented with the other's nonce.
    await w.peers.bob.receive({ ...other, sig: good.sig });
    expect(result(w)).toMatchObject({ ok: false, error: expect.stringMatching(/did not sign this conversation's challenge/) });
  });

  it("records one outcome when the same present arrives twice at once", async () => {
    const w = world();
    const frame = await present(w, w.addProof());
    await Promise.all([w.peers.bob.receive(frame), w.peers.bob.receive(frame)]);
    expect(w.ledgers.bob.received).toHaveLength(1);
    expect(w.sent("idp-result")).toHaveLength(1);
    expect(w.errors).toEqual(["Unknown or reused identity challenge"]);
  });

  it("replaces an older proof of the same identity, and keeps proofs of other identities", async () => {
    const w = world();
    const first = w.addProof();
    await w.peers.bob.receive(await present(w, first));
    w.state.subject = "someone-else";
    const other = w.addProof();
    await w.peers.bob.receive(await present(w, other));
    w.state.subject = SUBJECT;
    const newer = w.addProof();
    await w.peers.bob.receive(await present(w, newer));
    expect(w.ledgers.bob.received.map(r => r.id).sort()).toEqual([other, newer].sort());
  });
});

describe("re-checking a received proof", () => {
  async function received(w: ReturnType<typeof world>) {
    const id = w.addProof();
    await shareAndSettle(w, id);
    return id;
  }

  it("refuses an unknown id, and leaves a revoked proof alone without asking the provider", async () => {
    const w = world();
    await expect(w.peers.bob.recheck("f".repeat(64))).rejects.toThrow("Unknown identity");
    const id = await received(w);
    w.ledgers.bob.received[0].status = "revoked";
    w.verify.mockClear();
    expect((await w.peers.bob.recheck(id)).status).toBe("revoked");
    expect(w.verify).not.toHaveBeenCalled();
  });

  it("marks the proof unconfirmed when the provider now names another identity", async () => {
    const w = world();
    const id = await received(w);
    w.state.subject = "someone-else";
    expect(await w.peers.bob.recheck(id)).toMatchObject({ status: "unconfirmed", error: "The identity changed", verified: { subject: SUBJECT } });
  });

  it("keeps a withdrawn proof withdrawn whatever the re-check finds", async () => {
    const w = world();
    const id = await received(w);
    w.ledgers.bob.received[0].status = "withdrawn";
    expect((await w.peers.bob.recheck(id)).status).toBe("withdrawn");
    w.state.subject = "someone-else";
    expect(await w.peers.bob.recheck(id)).toMatchObject({ status: "withdrawn", error: "The identity changed" });
  });

  it("keeps the name and picture it had when the provider returns none, and takes a new one when it does", async () => {
    const w = world();
    const id = await received(w);
    const earlier = { source: "kind-0", fetchedAt: NOW, name: "Alice" };
    w.ledgers.bob.received[0].verified.display = earlier;
    expect((await w.peers.bob.recheck(id)).verified.display).toEqual(earlier);
    w.state.display = { source: "kind-0", fetchedAt: NOW + 1, name: "Alice B" };
    expect((await w.peers.bob.recheck(id)).verified.display).toEqual({ source: "kind-0", fetchedAt: NOW + 1, name: "Alice B" });
  });

  it("treats a failing revocation lookup as not revoked", async () => {
    const w = world();
    const id = await received(w);
    w.state.revokedFails = true;
    expect((await w.peers.bob.recheck(id, { revocationOnly: true })).status).toBe("verified");
  });

  it("uses the wall clock when no clock is given", async () => {
    vi.useFakeTimers({ now: 1_900_000_000_000 });
    let ledger = emptyIdentityLedger();
    const x = new IdentityExchange({ scope: () => ({ subject: "a", audience: "b", context: "c", session: "d" }), send: () => {},
      storage: { read: () => ledger, update: async change => { ledger = change(ledger); } }, providers: () => ["test"], localProof: () => undefined, verify: async () => ({ subject: "x", source: "y" }) });
    await x.receive({ t: "idp-request", id: "f".repeat(64), provider: "test" });
    expect(ledger.challenges[0].issuedAt).toBe(1_900_000_000);
  });
});
