import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createIdentity } from "../src/identity";
import {
  emptyIdentityLedger, IDENTITY_CHECK_UNAVAILABLE, IdentityCheckUnavailable, identityRefusal, identityStatement, identityStatementText, IdentityExchange, isIdentityBinding, newIdentityBinding,
  receivedIdentityStatus, revokesIdentity, identityRevocationValue, IDENTITY_REVOCATION_LABEL, signIdentityPresentation, verifyIdentityPresentation, IDENTITY_CHALLENGE_WINDOW,
  type IdentityBinding, type IdentityLedger, type IdentityStatement, type LocalIdentityProof, type VerifiedIdentity,
  IDENTITY_REUSE_CHECK_S,
} from "../src/identityProofs";
import { lastSharedWithMe } from "../src/identityTimeline";
// covers: proofs.binding, proofs.share, proofs.withdraw, proofs.revoke, proofs.expiry

const binding: IdentityBinding = {
  v: 1, provider: "nostr", subject: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  key: "yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", issuedAt: 1_800_000_000, expiresAt: 1_807_776_000, nonce: "AAAAAAAAAAAAAAAAAAAAAA",
};

describe("identity statement", () => {
  it("is one exact, domain-separated line every provider signs byte for byte", () => {
    const s = identityStatement(binding);
    expect(s.text).toBe("Ghostly identity proof v1: I control nostr:3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d " +
      "and authorize the Ghostly key yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy to present it to contacts I choose, " +
      "from 2027-01-15T08:00:00Z until 2027-04-15T08:00:00Z. Nonce: AAAAAAAAAAAAAAAAAAAAAA");
    expect(new TextDecoder().decode(s.bytes)).toBe(s.text);
    expect(s.id).toMatch(/^[a-f0-9]{64}$/);
    expect(identityStatement({ ...binding }).id).toBe(s.id);
    expect(identityStatement({ ...binding, nonce: "AAAAAAAAAAAAAAAAAAAAAB" }).id).not.toBe(s.id);
  });

  it("refuses fields that could make two bindings read the same", () => {
    const bad: Partial<IdentityBinding>[] = [
      { subject: "a b" }, { subject: "" }, { subject: "x".repeat(513) }, { subject: "é" }, { subject: "a\nb" },
      { provider: "Nostr" }, { provider: "no:str" }, { provider: "" }, { key: "abc" }, { nonce: "short" },
      { issuedAt: 0 }, { expiresAt: binding.issuedAt }, { expiresAt: binding.issuedAt + 401 * 86_400 }, { issuedAt: 1.5 },
    ];
    for (const change of bad) {
      expect(isIdentityBinding({ ...binding, ...change }), JSON.stringify(change)).toBe(false);
      expect(() => identityStatementText({ ...binding, ...change })).toThrow();
    }
    expect(isIdentityBinding({ ...binding, extra: 1 })).toBe(false);
    expect(isIdentityBinding({ ...binding, v: 2 })).toBe(false);
  });

  it("creates a binding with a fresh proof key whose seed signs presentations", () => {
    const { binding: b, seed } = newIdentityBinding({ provider: "nostr", subject: binding.subject, validitySeconds: 86_400, now: 1_800_000_000 });
    expect(b.expiresAt - b.issuedAt).toBe(86_400);
    const scope = { subject: createIdentity().pubKeyZ32, audience: createIdentity().pubKeyZ32, context: "a".repeat(64), session: "b".repeat(64) };
    const id = identityStatement(b).id;
    const sig = signIdentityPresentation(seed, id, scope, "N".repeat(43), 1);
    expect(verifyIdentityPresentation(b.key, sig, id, scope, "N".repeat(43), 1)).toBe(true);
    for (const other of [{ ...scope, audience: createIdentity().pubKeyZ32 }, { ...scope, context: "c".repeat(64) }, { ...scope, session: "d".repeat(64) }, { ...scope, subject: scope.audience, audience: scope.subject }])
      expect(verifyIdentityPresentation(b.key, sig, id, other, "N".repeat(43), 1)).toBe(false);
    expect(verifyIdentityPresentation(b.key, sig, id, scope, "M".repeat(43), 1)).toBe(false);
    expect(verifyIdentityPresentation(createIdentity().pubKeyZ32, sig, id, scope, "N".repeat(43), 1)).toBe(false);
    expect(() => newIdentityBinding({ provider: "nostr", subject: "has space", validitySeconds: 86_400 })).toThrow();
  });
});

/** A fake provider: the subject is an Ed25519 public key (hex) that signs the statement bytes. */
const externalSeed = ed25519.utils.randomSecretKey();
const externalKey = Array.from(ed25519.getPublicKey(externalSeed), b => b.toString(16).padStart(2, "0")).join("");
const fakeVerify = async (s: IdentityStatement, evidence: unknown): Promise<VerifiedIdentity> => {
  const sig = Uint8Array.from((evidence as { sig: number[] }).sig);
  if (!ed25519.verify(sig, s.bytes, ed25519.getPublicKey(externalSeed)) || s.binding.subject !== externalKey) throw new Error("Invalid signature");
  return { subject: s.binding.subject, source: "Test signature" };
};

function world(start = 1_800_000_000) {
  let now = start;
  const proofs = new Map<string, LocalIdentityProof>();
  const addProof = (validitySeconds = 30 * 86_400) => {
    const { binding: b, seed } = newIdentityBinding({ provider: "test", subject: externalKey, validitySeconds, now });
    const statement = identityStatement(b);
    proofs.set(statement.id, { statement, evidence: { sig: Array.from(ed25519.sign(statement.bytes, externalSeed)) }, seed });
    return statement.id;
  };
  const ledgers = new Map<string, IdentityLedger>();
  const peers = new Map<string, IdentityExchange>();
  const frames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const online = new Set<string>();
  const revoked = new Set<string>();
  const peer = (me: string, them: string, context: string, options: { providers?: string[]; session?: () => string; verify?: typeof fakeVerify } = {}) => {
    const key = `${me}>${them}`;
    ledgers.set(key, ledgers.get(key) ?? emptyIdentityLedger());
    const x = new IdentityExchange({
      scope: () => ({ subject: me, audience: them, context, session: options.session?.() ?? "s".repeat(64) }),
      send: frame => { frames.push(structuredClone(frame) as Record<string, unknown>); const to = `${them}>${me}`; if (online.has(to)) queueMicrotask(() => void peers.get(to)?.receive(structuredClone(frame) as Record<string, unknown>)); },
      storage: { read: () => ledgers.get(key)!, update: async change => { ledgers.set(key, change(structuredClone(ledgers.get(key)!))); } },
      providers: () => options.providers ?? ["test"],
      localProof: id => proofs.get(id),
      verify: options.verify ?? fakeVerify, now: () => now, onError: e => errors.push(e),
      revoked: async st => revoked.has(st.id),
    });
    peers.set(key, x); online.add(key);
    return x;
  };
  const ids = { alice: createIdentity().pubKeyZ32, bob: createIdentity().pubKeyZ32, carol: createIdentity().pubKeyZ32 };
  return { ids, peer, peers, ledgers, revoked, frames, errors, online, proofs, addProof, advance: (s: number) => { now += s; }, now: () => now,
    ledger: (me: string, them: string) => ledgers.get(`${me}>${them}`)! };
}

describe("identity exchange", () => {
  it("shares with one contact only; the other sees nothing", async () => {
    const w = world(), { alice, bob, carol } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    w.peer(alice, carol, "c".repeat(64)); w.peer(carol, alice, "c".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("accepted"));
    const got = w.ledger(bob, alice).received;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id, presenter: alice, audience: bob, status: "verified", verified: { subject: externalKey } });
    expect(receivedIdentityStatus(got[0], alice, bob, w.now())).toBe("verified");
    expect(w.ledger(carol, alice).received).toHaveLength(0);
    expect(w.ledger(bob, alice).challenges).toHaveLength(0);
  });

  it("refuses a presentation replayed to the same contact, after a restart, or to another contact", async () => {
    const w = world(), { alice, bob, carol } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64)); w.peer(carol, alice, "c".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    const present = w.frames.find(f => f.t === "idp-present")!;
    // Same contact, same nonce: consumed.
    await w.peers.get(`${bob}>${alice}`)!.receive(present);
    expect(w.errors.at(-1)).toMatch(/Unknown or reused/);
    // Bob's app restarts: the ledger on disk still refuses it.
    const restarted = w.peer(bob, alice, "a".repeat(64));
    await restarted.receive(present);
    expect(w.errors.at(-1)).toMatch(/Unknown or reused/);
    // Carol gets a copy with a nonce of her own: signed for Bob, not her.
    await w.peers.get(`${carol}>${alice}`)!.receive({ t: "idp-request", id, provider: "test" });
    const challenge = w.frames.filter(f => f.t === "idp-challenge").at(-1)!;
    await w.peers.get(`${carol}>${alice}`)!.receive({ ...present, nonce: challenge.nonce, issuedAt: challenge.issuedAt });
    expect(w.ledger(carol, alice).received).toHaveLength(0);
    expect(w.frames.at(-1)).toMatchObject({ t: "idp-result", ok: false, error: expect.stringMatching(/proof key/) });
    expect(w.ledger(carol, alice).challenges).toHaveLength(0);
  });

  it("refuses a presentation from another session of the same conversation", async () => {
    const w = world(), { alice, bob } = w.ids;
    let session = "s".repeat(64);
    const ab = w.peer(alice, bob, "a".repeat(64), { session: () => "s".repeat(64) });
    w.peer(bob, alice, "a".repeat(64), { session: () => session });
    session = "t".repeat(64);
    await ab.share(w.addProof(), true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("rejected"));
    expect(w.ledger(bob, alice).received).toHaveLength(0);
  });

  it("refuses an answer after the challenge window", async () => {
    const w = world(), { alice, bob } = w.ids;
    w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    w.online.delete(`${bob}>${alice}`);
    const id = w.addProof();
    await w.peers.get(`${alice}>${bob}`)!.share(id, true);
    await ba.receive(w.frames.find(f => f.t === "idp-request")!);
    await w.peers.get(`${alice}>${bob}`)!.receive(w.frames.find(f => f.t === "idp-challenge")!);
    w.advance(IDENTITY_CHALLENGE_WINDOW + 1);
    await ba.receive(w.frames.find(f => f.t === "idp-present")!);
    expect(w.errors.at(-1)).toMatch(/Unknown or reused/);
    expect(w.ledger(bob, alice).received).toHaveLength(0);
  });

  it("shows an accepted proof as expired once its validity ends, and refuses to accept an expired one", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof(3600);
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    w.advance(3600);
    expect(receivedIdentityStatus(w.ledger(bob, alice).received[0], alice, bob, w.now())).toBe("expired");
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("rejected"));
    expect(w.ledger(alice, bob).shared[0].error).toMatch(/expired/);
  });

  it("marks a received proof of another participation key as a previous key", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    await ab.share(w.addProof(), true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    expect(receivedIdentityStatus(w.ledger(bob, alice).received[0], createIdentity().pubKeyZ32, bob, w.now())).toBe("previous-key");
  });

  it("queues a share while the contact is away and sends it when the channel is ready", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, false);
    expect(w.ledger(alice, bob).shared[0].status).toBe("queued");
    expect(w.frames).toHaveLength(0);
    ab.ready();
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("accepted"));
    expect(w.frames[0]).toEqual({ t: "idp-hello", providers: ["test"] });
  });

  it("withdraws: the contact marks it withdrawn and acknowledges, also after a reconnect", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("accepted"));
    await ab.withdraw(id, false);
    expect(w.ledger(alice, bob).shared[0].status).toBe("withdrawal-pending");
    ab.ready();
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("withdrawn"));
    expect(w.ledger(bob, alice).received[0].status).toBe("withdrawn");
    expect(receivedIdentityStatus(w.ledger(bob, alice).received[0], alice, bob, w.now())).toBe("withdrawn");
  });

  it("a second proof of the same identity the contact accepts replaces the first on both sides", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const older = w.addProof();
    w.advance(60);
    const newer = w.addProof();
    const status = (id: string) => w.ledger(alice, bob).shared.find(s => s.id === id)?.status;
    await ab.share(older, true);
    await vi.waitFor(() => expect(status(older)).toBe("accepted"));
    await ab.share(newer, true);
    await vi.waitFor(() => expect(status(newer)).toBe("accepted"));
    // The contact keeps one proof per identity: the older one is gone there, so it is no longer shared here either.
    expect(w.ledger(bob, alice).received.map(r => r.id)).toEqual([newer]);
    expect(status(older)).toBe("withdrawn");
    // Taking the newer one back leaves nothing standing on either side.
    await ab.withdraw(newer, true);
    await vi.waitFor(() => expect(status(newer)).toBe("withdrawn"));
    expect(w.ledger(bob, alice).received.map(r => `${r.id}:${r.status}`)).toEqual([`${newer}:withdrawn`]);
    expect(w.ledger(alice, bob).shared.filter(s => s.status === "accepted")).toEqual([]);
  });

  it("withdrawing a share still queued just forgets it", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, false);
    await ab.withdraw(id, true);
    expect(w.ledger(alice, bob).shared).toEqual([]);
    expect(w.frames).toHaveLength(0);
  });

  it("tells the sharer when the contact cannot verify this provider, without issuing a challenge", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64), { providers: [] });
    await ab.share(w.addProof(), true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0]).toMatchObject({ status: "queued" }));
    await vi.waitFor(() => expect(w.frames.at(-1)).toMatchObject({ t: "idp-result", ok: false }));
    expect(w.ledger(bob, alice).challenges).toHaveLength(0);
  });

  it("ignores challenges it did not ask for, and bounds outstanding challenges", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    w.online.clear();
    await ab.receive({ t: "idp-challenge", id: "f".repeat(64), nonce: "N".repeat(43), issuedAt: w.now() });
    expect(w.frames).toHaveLength(0);
    for (let i = 0; i < 9; i++) await ba.receive({ t: "idp-request", id: "f".repeat(64), provider: "test" });
    expect(w.ledger(bob, alice).challenges).toHaveLength(8);
    expect(w.errors.at(-1)).toMatch(/Too many/);
  });

  it("re-checks a received proof and says so honestly when it no longer verifies", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    w.advance(100);
    expect((await ba.recheck(id)).status).toBe("verified");
    const stored = w.ledger(bob, alice);
    w.ledgers.set(`${bob}>${alice}`, { ...stored, received: [{ ...stored.received[0], evidence: { sig: Array(64).fill(0) } }] });
    const after = await ba.recheck(id);
    expect(after).toMatchObject({ status: "unconfirmed", error: "Invalid signature", checkedAt: w.now() });
    expect(receivedIdentityStatus(after, alice, bob, w.now())).toBe("unconfirmed");
  });

  it("tells the sharer only that it could not be checked when the check failed on this side's network", async () => {
    const w = world(), { alice, bob } = w.ids;
    let failure: Error | undefined = new IdentityCheckUnavailable("The homeserver jenkins.corp.example.com answered 503");
    const ab = w.peer(alice, bob, "a".repeat(64));
    const ba = w.peer(bob, alice, "a".repeat(64), { verify: async (s, e) => { if (failure) throw failure; return fakeVerify(s, e); } });
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("rejected"));
    expect(w.ledger(alice, bob).shared[0].error).toBe(IDENTITY_CHECK_UNAVAILABLE);
    // The detail itself, not a bare "503": the frames carry random keys and signatures, where those digits turn up.
    expect(JSON.stringify(w.frames)).not.toMatch(/jenkins|answered 503/);
    // Any other refusal is sent as it is, and the sharer keeps the default line: words its app cannot tell from the contact's own.
    failure = new Error("The file on the homeserver is not this proof");
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].error).toBe("Your contact could not verify it"));
    expect(w.frames.filter(f => f.t === "idp-result").at(-1)).toMatchObject({ ok: false, error: "The file on the homeserver is not this proof" });
    // The verifier's own re-check keeps the detail.
    failure = undefined;
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    failure = new IdentityCheckUnavailable("The homeserver jenkins.corp.example.com answered 503");
    expect(await ba.recheck(id)).toMatchObject({ status: "unconfirmed", error: "The homeserver jenkins.corp.example.com answered 503" });
  });

  it("drops oversized frames", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ba = w.peer(bob, alice, "a".repeat(64));
    await ba.receive({ t: "idp-present", junk: "x".repeat(40_000) });
    expect(w.errors.at(-1)).toMatch(/too large/);
  });

  it("reads a revocation record: exact label, this proof's id, nothing else", () => {
    const id = "a".repeat(64);
    expect(revokesIdentity([{ label: IDENTITY_REVOCATION_LABEL, value: identityRevocationValue(id, 1_800_000_000) }], id)).toBe(true);
    expect(revokesIdentity([{ label: IDENTITY_REVOCATION_LABEL, value: identityRevocationValue("b".repeat(64), 1) }], id)).toBe(false);
    expect(revokesIdentity([{ label: "_other", value: identityRevocationValue(id, 1) }], id)).toBe(false);
    expect(revokesIdentity([{ label: IDENTITY_REVOCATION_LABEL, value: `${identityRevocationValue(id, 1)};x` }], id)).toBe(false);
  });

  it("a revoked proof shows as revoked on re-check, and is refused when presented again", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).received).toHaveLength(1));
    expect((await ba.recheck(id, { revocationOnly: true })).status).toBe("verified");
    w.revoked.add(id);
    const after = await ba.recheck(id, { revocationOnly: true });
    expect(after.status).toBe("revoked");
    expect(receivedIdentityStatus(after, alice, bob, w.now())).toBe("revoked");
    // Someone who still has the proof key presents it again: refused.
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("rejected"));
    expect(w.ledger(alice, bob).shared[0].error).toMatch(/revoked/);
  });
});

describe("identity timeline, from the exchange", () => {
  const tl = (w: ReturnType<typeof world>, me: string, them: string) => w.ledger(me, them).timeline ?? [];

  it("both sides get one entry for a share: verifying, then verified", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    w.online.clear();
    const id = w.addProof();
    await ab.share(id, true);
    expect(tl(w, alice, bob)).toEqual([{ id: `mine:${id}:0`, proof: id, side: "mine", kind: "shared", provider: "test", subject: externalKey, state: "verifying", at: w.now() * 1000 }]);
    await ba.receive(w.frames.find(f => f.t === "idp-request")!);
    // The contact knows the kind at once, the identity only once it is presented.
    expect(tl(w, bob, alice)).toEqual([{ id: `theirs:${id}:0`, proof: id, side: "theirs", kind: "shared", provider: "test", state: "verifying", at: w.now() * 1000 }]);
    await ab.receive(w.frames.find(f => f.t === "idp-challenge")!);
    w.advance(2);
    await ba.receive(w.frames.find(f => f.t === "idp-present")!);
    expect(tl(w, bob, alice)).toEqual([expect.objectContaining({ state: "verified", subject: externalKey, at: (w.now() - 2) * 1000 })]);
    expect(tl(w, alice, bob)[0].state).toBe("verifying");
    await ab.receive(w.frames.find(f => f.t === "idp-result")!);
    expect(tl(w, alice, bob)).toEqual([expect.objectContaining({ state: "verified" })]);
  });

  it("a refused share turns failed on both sides, with the reason: the verifier's own, the sharer's in its app's words", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64));
    w.peer(bob, alice, "a".repeat(64), { verify: async () => { throw new Error("The file on the homeserver is not this proof"); } });
    await ab.share(w.addProof(), true);
    await vi.waitFor(() => expect(tl(w, alice, bob)[0]?.state).toBe("failed"));
    expect(tl(w, alice, bob)[0].error).toBe("Your contact could not verify it");
    expect(tl(w, bob, alice)).toEqual([expect.objectContaining({ side: "theirs", state: "failed", error: "The file on the homeserver is not this proof", subject: externalKey })]);
  });

  it("a refused share tried again is a new attempt (the contact's line taken over), never a stop; stopping a refused one writes no stop line", async () => {
    const w = world(), { alice, bob } = w.ids;
    let refuse = true;
    const ab = w.peer(alice, bob, "a".repeat(64));
    w.peer(bob, alice, "a".repeat(64), { verify: async (s, e) => { if (refuse) throw new Error("Quad9 could not be reached"); return fakeVerify(s, e); } });
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, alice, bob)[0]?.state).toBe("failed"));
    // Shared again straight from the failed state (the picker's "Share again"): no "You stopped sharing" in between.
    refuse = false;
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, alice, bob)[1]?.state).toBe("verified"));
    const kinds = (me: string, them: string) => tl(w, me, them).map(e => `${e.kind}:${e.state ?? e.reason}`);
    expect(kinds(alice, bob)).toEqual(["shared:failed", "shared:verified"]);
    // On the contact's side its retry takes the failed line over: one line per kind not verified (see the flood below).
    expect(kinds(bob, alice)).toEqual(["shared:verified"]);
    // A refused share taken back: the contact never held it, so neither side shows a stop.
    const other = w.addProof();
    refuse = true;
    await ab.share(other, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared.find(s => s.id === other)?.status).toBe("rejected"));
    await ab.withdraw(other, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared.find(s => s.id === other)?.status).toBe("withdrawn"));
    expect(kinds(alice, bob).slice(2)).toEqual(["shared:failed"]);
    expect(kinds(bob, alice).slice(1)).toEqual(["shared:failed"]);
  });

  it("a kind the contact's app cannot verify is refused at once, with no write on the verifier's side", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64), { providers: [] });
    await ab.share(w.addProof(), true);
    // The kind is the contact's to name, so the verifier replies "cannot verify" at once but keeps no timeline line
    // and no challenge for it: a flood of such requests cannot fill the timeline or ring the cue.
    await vi.waitFor(() => expect(w.frames.some(f => f.t === "idp-result" && f.ok === false && /cannot verify/.test(String(f.error)))).toBe(true));
    expect(tl(w, bob, alice)).toHaveLength(0);
    expect(w.ledger(bob, alice).challenges).toHaveLength(0);
  });

  it("a flood of unverifiable requests and unknown withdraws writes nothing, keeping the real verified line", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    // Alice shares a real proof; Bob's timeline shows it verified.
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, bob, alice)[0]?.state).toBe("verified"));
    // The contact floods requests for kinds this app does not verify (a fresh id and provider each time) and
    // withdraws of ids this side never received. Before the fix each one was a durable write (the timeline cap is
    // 100, so the verified line was pushed out) and a reply; now none of them touches the ledger.
    for (let i = 0; i < 2000; i++) {
      const fresh = i.toString(16).padStart(64, "0");
      await ba.receive({ t: "idp-request", id: fresh, provider: `p${i}` });
      await ba.receive({ t: "idp-withdraw", id: fresh });
    }
    expect(tl(w, bob, alice)).toEqual([expect.objectContaining({ proof: id, side: "theirs", state: "verified" })]);
    expect(w.ledger(bob, alice).challenges).toHaveLength(0);
  });

  it("a flood of requests for a kind this app verifies, failed or never presented, keeps one line of the contact's and every other", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    // Alice's real share, verified on Bob's side; Bob's own share, accepted by Alice.
    await ab.share(w.addProof(), true);
    await vi.waitFor(() => expect(tl(w, bob, alice)[0]?.state).toBe("verified"));
    await ba.share(w.addProof(), true);
    await vi.waitFor(() => expect(w.ledger(bob, alice).shared[0]?.status).toBe("accepted"));
    const before = tl(w, bob, alice);
    expect(before.map(e => `${e.side}:${e.state}`)).toEqual(["theirs:verified", "mine:verified"]);
    const firstAt = (w.now() + 3) * 1000;
    const throwaway = (subject: string) => newIdentityBinding({ provider: "test", subject, validitySeconds: 86_400, now: w.now() }).binding;
    let n = 0;
    const fresh = () => (n++).toString(16).padStart(64, "0");
    // A request for a fresh id, then a presentation of a throwaway binding with garbage evidence: the check fails.
    for (let i = 0; i < 120; i++) {
      const id = fresh();
      w.advance(3);
      await ba.receive({ t: "idp-request", id, provider: "test" });
      const c = w.ledger(bob, alice).challenges.find(x => x.id === id)!;
      await ba.receive({ t: "idp-present", nonce: c.nonce, issuedAt: c.issuedAt, binding: throwaway("rnichael"), evidence: { sig: [1] }, sig: "x" });
    }
    // Requests only, never presented: as many as the live challenges allow, window after window.
    for (let win = 0; win < 14; win++) {
      for (let i = 0; i < 8; i++) await ba.receive({ t: "idp-request", id: fresh(), provider: "test" });
      w.advance(IDENTITY_CHALLENGE_WINDOW + 1);
    }
    const after = tl(w, bob, alice);
    expect(after.slice(0, 2)).toEqual(before);
    // The contact's line keeps its first id and time: no new sound for it, and the chat moved up once only.
    expect(after.slice(2)).toEqual([expect.objectContaining({ id: `theirs:${"0".repeat(64)}:0`, side: "theirs", kind: "shared", state: "verifying", at: firstAt })]);
    expect(lastSharedWithMe(after)).toBe(firstAt);
  });

  it("is not repeated when the request goes again at a reconnect, nor by a refresh", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    // Shared while away, then two reconnects before the answer: one entry each side.
    w.online.delete(`${bob}>${alice}`);
    await ab.share(id, false);
    ab.ready(); ab.ready();
    expect(tl(w, alice, bob)).toHaveLength(1);
    w.online.add(`${bob}>${alice}`);
    ab.ready();
    await vi.waitFor(() => expect(tl(w, alice, bob)[0].state).toBe("verified"));
    // A restart of both apps reads the same ledgers and greets again.
    const ab2 = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    ab2.ready();
    await ab2.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("accepted"));
    expect(tl(w, alice, bob)).toEqual([expect.objectContaining({ id: `mine:${id}:0`, state: "verified" })]);
    expect(tl(w, bob, alice)).toEqual([expect.objectContaining({ id: `theirs:${id}:0`, state: "verified" })]);
  });

  it("stopping is one entry on each side; sharing again after it is a new one", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, bob, alice)[0]?.state).toBe("verified"));
    await ab.withdraw(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).toBe("withdrawn"));
    // Told again at a reconnect: still one stop.
    await w.peers.get(`${bob}>${alice}`)!.receive({ t: "idp-withdraw", id });
    const kinds = (me: string, them: string) => tl(w, me, them).map(e => `${e.kind}${e.reason ? `:${e.reason}` : ""}`);
    expect(kinds(alice, bob)).toEqual(["shared", "stopped:withdrawn"]);
    expect(kinds(bob, alice)).toEqual(["shared", "stopped:withdrawn"]);
    expect(tl(w, bob, alice)[1]).toMatchObject({ provider: "test", subject: externalKey });
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, bob, alice)).toHaveLength(3));
    await vi.waitFor(() => expect(tl(w, alice, bob)[2]).toMatchObject({ id: `mine:${id}:2`, kind: "shared", state: "verified" }));
    expect(tl(w, bob, alice)[2]).toMatchObject({ kind: "shared", state: "verified" });
  });

  it("a newer proof of the same identity stops the older one's share on both sides, and nothing more once that one is removed", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); w.peer(bob, alice, "a".repeat(64));
    const older = w.addProof();
    w.advance(60);
    const newer = w.addProof();
    await ab.share(older, true);
    await vi.waitFor(() => expect(tl(w, bob, alice)[0]?.state).toBe("verified"));
    await ab.share(newer, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared.find(s => s.id === newer)?.status).toBe("accepted"));
    const steps = (me: string, them: string) => tl(w, me, them).map(e => `${e.proof === older ? "older" : "newer"}:${e.kind}:${e.state ?? e.reason}`);
    // The contact no longer holds the older one: neither chat goes on showing it as a live, verified share.
    expect(steps(bob, alice)).toEqual(["older:shared:verified", "newer:shared:verified", "older:stopped:withdrawn"]);
    expect(steps(alice, bob)).toEqual(["older:shared:verified", "newer:shared:verified", "older:stopped:withdrawn"]);
    expect(tl(w, bob, alice)[2]).toMatchObject({ provider: "test", subject: externalKey });
    expect(tl(w, alice, bob)[2]).toMatchObject({ provider: "test", subject: externalKey });
    // Taking the older one back now sends nothing and writes nothing more.
    const sent = w.frames.length;
    await ab.withdraw(older, true);
    expect(w.frames).toHaveLength(sent);
    expect(steps(alice, bob)).toHaveLength(3);
  });

  for (const slower of ["older", "newer"] as const) for (const run of [1, 2, 3])
  it(`two proofs of one identity checked at once: the newer is kept on both sides when the ${slower} check ends last (run ${run})`, async () => {
    const w = world(), { alice, bob } = w.ids;
    const older = w.addProof();
    w.advance(60);
    const newer = w.addProof();
    // The slower proof's check ends only once the other one is stored.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slowId = slower === "older" ? older : newer;
    const ab = w.peer(alice, bob, "a".repeat(64));
    w.peer(bob, alice, "a".repeat(64), { verify: async (s, e) => { if (s.id === slowId) await gate; return fakeVerify(s, e); } });
    await ab.share(older, false);
    await ab.share(newer, false);
    ab.ready();
    await vi.waitFor(() => expect(w.ledger(bob, alice).received.map(r => r.id)).toEqual([slower === "older" ? newer : older]));
    release();
    const status = (id: string) => w.ledger(alice, bob).shared.find(s => s.id === id)?.status;
    await vi.waitFor(() => expect(status(older)).not.toBe("pending"));
    await vi.waitFor(() => expect(status(newer)).toBe("accepted"));
    expect(w.ledger(bob, alice).received.map(r => `${r.id === older ? "older" : "newer"}:${r.status}`)).toEqual(["newer:verified"]);
    expect(status(older)).toBe(slower === "older" ? "rejected" : "withdrawn");
    if (slower === "older") expect(identityRefusal(w.ledger(alice, bob).shared.find(s => s.id === older)?.error)).toMatch(/newer proof/);
    expect(w.ledger(alice, bob).shared.filter(s => s.status === "accepted").map(s => s.id)).toEqual([newer]);
    // Nothing on the contact's timeline stops the newer share.
    expect(tl(w, bob, alice).some(e => e.proof === newer && e.kind === "stopped")).toBe(false);
    expect(tl(w, alice, bob).some(e => e.proof === newer && e.kind === "stopped")).toBe(false);
  });

  it("a share taken back before it left leaves nothing; a revocation found is a stop", async () => {
    const w = world(), { alice, bob } = w.ids;
    const ab = w.peer(alice, bob, "a".repeat(64)); const ba = w.peer(bob, alice, "a".repeat(64));
    const queued = w.addProof();
    await ab.share(queued, false);
    await ab.withdraw(queued, false);
    expect(tl(w, alice, bob)).toEqual([]);
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(tl(w, bob, alice)[0]?.state).toBe("verified"));
    w.revoked.add(id);
    await ba.recheck(id, { revocationOnly: true });
    await ba.recheck(id);
    expect(tl(w, bob, alice).map(e => e.reason ?? e.kind)).toEqual(["shared", "revoked"]);
  });
});

describe("a share asked again after its result was lost", () => {
  /** Alice shares; Bob verifies and keeps it, but his result never reaches her (the link closed during his check). */
  async function lostResult(second: () => Promise<VerifiedIdentity>) {
    const w = world(), { alice, bob } = w.ids;
    let check = 0;
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const ab = w.peer(alice, bob, "a".repeat(64));
    w.peer(bob, alice, "a".repeat(64), { verify: async (s, e) => {
      if (++check === 1) { await held; return fakeVerify(s, e); }
      return second();
    } });
    const id = w.addProof();
    await ab.share(id, true);
    await vi.waitFor(() => expect(check).toBe(1));
    w.online.delete(`${alice}>${bob}`);
    release();
    await vi.waitFor(() => expect(w.ledger(bob, alice).received[0]?.status).toBe("verified"));
    await new Promise(r => setTimeout(r, 0));
    expect(w.ledger(alice, bob).shared[0].status).toBe("pending");
    // Reconnect past the hour a verified check is reused for (`IDENTITY_REUSE_CHECK_S`): the share still pending is asked
    // again, and Bob checks it a second time.
    w.online.add(`${alice}>${bob}`);
    w.advance(IDENTITY_REUSE_CHECK_S + 10);
    ab.ready();
    await vi.waitFor(() => expect(check).toBe(2));
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].status).not.toBe("pending"));
    const card = (me: string, them: string) => (w.ledger(me, them).timeline ?? []).map(e => `${e.kind}:${e.state}`);
    return { w, alice, bob, card };
  }

  it("a second check that could not run leaves the held copy standing, and both sides say it is held", async () => {
    const { w, alice, bob, card } = await lostResult(async () => { throw new IdentityCheckUnavailable("probe resolver could not be reached"); });
    expect(w.ledger(bob, alice).received[0].status).toBe("verified");
    expect(w.ledger(alice, bob).shared[0].status).toBe("accepted");
    expect(card(alice, bob)).toEqual(["shared:verified"]);
    expect(card(bob, alice)).toEqual(["shared:verified"]);
  });

  it("a second check that fails for a real reason turns the held copy unconfirmed, and the sharer is told", async () => {
    const { w, alice, bob, card } = await lostResult(async () => { throw new Error("The record is gone"); });
    expect(w.ledger(bob, alice).received[0]).toMatchObject({ status: "unconfirmed", error: "The record is gone", checkedAt: w.now() });
    expect(w.ledger(alice, bob).shared[0]).toMatchObject({ status: "rejected", error: "Your contact could not verify it" });
    expect(card(alice, bob)).toEqual(["shared:failed"]);
    expect(card(bob, alice)).toEqual(["shared:failed"]);
  });

  it("a second check that passes refreshes the held copy and settles the share", async () => {
    const { w, alice, bob, card } = await lostResult(async () => ({ subject: externalKey, source: "Test signature" }));
    expect(w.ledger(bob, alice).received).toEqual([expect.objectContaining({ status: "verified", checkedAt: w.now() })]);
    expect(w.ledger(alice, bob).shared[0].status).toBe("accepted");
    expect(card(alice, bob)).toEqual(["shared:verified"]);
    expect(card(bob, alice)).toEqual(["shared:verified"]);
  });
});
