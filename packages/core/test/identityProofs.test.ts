import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createIdentity } from "../src/identity";
import {
  emptyIdentityLedger, IDENTITY_CHECK_UNAVAILABLE, IdentityCheckUnavailable, identityStatement, identityStatementText, IdentityExchange, isIdentityBinding, newIdentityBinding,
  receivedIdentityStatus, revokesIdentity, identityRevocationValue, IDENTITY_REVOCATION_LABEL, signIdentityPresentation, verifyIdentityPresentation, IDENTITY_CHALLENGE_WINDOW,
  type IdentityBinding, type IdentityLedger, type IdentityStatement, type LocalIdentityProof, type VerifiedIdentity,
} from "../src/identityProofs";
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
    expect(JSON.stringify(w.frames)).not.toMatch(/jenkins|503/);
    // Any other refusal still says why: it is about the proof, not about the verifier's network.
    failure = new Error("The file on the homeserver is not this proof");
    await ab.share(id, true);
    await vi.waitFor(() => expect(w.ledger(alice, bob).shared[0].error).toBe("The file on the homeserver is not this proof"));
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
