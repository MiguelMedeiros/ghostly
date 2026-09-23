import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdentity, emptyIdentityLedger, identityStatement, IdentityExchange, IDENTITY_MAX_EVIDENCE, newIdentityBinding,
  type IdentityBinding, type IdentityLedger, type IdentityStatement, type LocalIdentityProof,
} from "@ghostly/core";
import type { IdentityFetch, IdentityProofProvider, VerifyContext } from "../../src/proofs/contract";
import { descriptorProblems, verifyIdentity } from "../../src/proofs/verify";

/**
 * The identity-proof contract as tests: every provider runs these against itself, with a harness that
 * can produce evidence for it (a test key, a stubbed network). See PROOFS.md. Provider-specific tests
 * (real tool output, vectors, malformed inputs of its format) go next to these.
 *
 *   describeIdentityProof("SSH", async () => ({ provider: ssh, subject, prove: s => sshSign(s, key), proveAsOther: s => sshSign(s, otherKey) }));
 */
export interface IdentityProofHarness<E> {
  provider: IdentityProofProvider<E>;
  /** A canonical subject this harness controls (self-custodied), or the issuer (provider-attested). */
  subject: string;
  /** Valid evidence for `statement`, the way the provider's signer would produce it. */
  prove(statement: IdentityStatement): Promise<E>;
  /** Evidence for the same statement by another key/account: a self-custodied provider must refuse it. */
  proveAsOther?(statement: IdentityStatement): Promise<E>;
  /** The network the verifier sees (DNS, JWKS, published keys). Defaults to one that refuses everything. */
  fetch?: IdentityFetch;
  /** Make proofs made so far fail a re-check (unpublish the record, revoke the key). Providers with `recheck`. */
  revoke?(): void | Promise<void>;
  /** Seconds; defaults to the real clock. */
  now?: number;
}

const refuseNetwork: IdentityFetch = async url => { throw new Error(`Unexpected network access: ${url}`); };

export function describeIdentityProof<E>(name: string, make: () => Promise<IdentityProofHarness<E>>, { timeout = 10_000 } = {}) {
  describe(`${name}: the IdentityProofProvider contract`, () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const ctxOf = (h: IdentityProofHarness<E>): VerifyContext => ({ now: h.now ?? Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch: h.fetch ?? refuseNetwork });
    const statementFor = (h: IdentityProofHarness<E>, change: Partial<IdentityBinding> = {}): IdentityStatement => {
      const { binding } = newIdentityBinding({ provider: h.provider.id, subject: h.subject, validitySeconds: h.provider.validity.defaultDays * 86_400, now: h.now });
      return identityStatement({ ...binding, ...change });
    };
    const verify = (h: IdentityProofHarness<E>, statement: IdentityStatement, evidence: unknown) =>
      verifyIdentity([h.provider as IdentityProofProvider], statement, JSON.parse(JSON.stringify(evidence)), ctxOf(h));

    it("has a well-formed descriptor", async () => {
      const h = await make();
      expect(descriptorProblems(h.provider as IdentityProofProvider)).toEqual([]);
      expect(h.provider.subject.normalize(h.subject)).toBe(h.subject);
      if (h.provider.subject.options) expect(h.provider.subject.options.map(o => o.value)).toContain(h.subject);
    });

    it("verifies its own evidence, after a trip through JSON, and says how", async () => {
      const h = await make();
      const statement = statementFor(h);
      const evidence = await h.prove(statement);
      expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(IDENTITY_MAX_EVIDENCE);
      const verified = await verify(h, statement, evidence);
      expect(verified.source.length).toBeGreaterThan(0);
      if (h.provider.category === "self-custodied") expect(verified.subject).toBe(h.subject);
      else expect(verified.attester).toBeTruthy();
      if (verified.expiresAt !== undefined) expect(verified.expiresAt).toBeGreaterThan(statement.binding.issuedAt);
    }, timeout);

    it("verifies through ctx.fetch only, never the global fetch", async () => {
      const h = await make();
      const statement = statementFor(h);
      const evidence = await h.prove(statement);
      const global = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch used"));
      await verify(h, statement, evidence);
      expect(global).not.toHaveBeenCalled();
    }, timeout);

    it("refuses evidence made for another statement: each field of the binding counts", async () => {
      const h = await make();
      const statement = statementFor(h);
      const evidence = await h.prove(statement);
      const b = statement.binding;
      const changes: Partial<IdentityBinding>[] = [
        { key: createIdentity().pubKeyZ32 },
        { nonce: "A".repeat(22) },
        { issuedAt: b.issuedAt - 1 },
        { expiresAt: b.expiresAt + 1 },
      ];
      for (const change of changes) await expect(verify(h, identityStatement({ ...b, ...change }), evidence), JSON.stringify(change)).rejects.toThrow();
    }, timeout);

    it("refuses another identity's evidence", async () => {
      const h = await make();
      if (!h.proveAsOther) return;
      const statement = statementFor(h);
      await expect(verify(h, statement, await h.proveAsOther(statement))).rejects.toThrow();
    }, timeout);

    it("refuses malformed evidence before verifying", async () => {
      const h = await make();
      const statement = statementFor(h);
      const evidence = await h.prove(statement);
      const garbage: unknown[] = [null, 42, "evidence", [], [evidence], { ...(evidence as object), extra: "x" }, { junk: "x".repeat(IDENTITY_MAX_EVIDENCE) }];
      for (const raw of garbage) await expect(verifyIdentity([h.provider as IdentityProofProvider], statement, raw, ctxOf(h))).rejects.toThrow();
    }, timeout);

    it("refuses a proof lasting longer than the provider allows", async () => {
      const h = await make();
      const b = statementFor(h).binding;
      if (h.provider.validity.maxDays >= 400) return;
      const long = identityStatement({ ...b, expiresAt: b.issuedAt + (h.provider.validity.maxDays + 1) * 86_400 });
      await expect(verify(h, long, await h.prove(long))).rejects.toThrow(/longer/);
    }, timeout);

    it("is verified by the contact it is shared with, and a copy replayed to another contact fails", async () => {
      const h = await make();
      const provider = h.provider as IdentityProofProvider;
      const { binding, seed } = newIdentityBinding({ provider: provider.id, subject: h.subject, validitySeconds: provider.validity.defaultDays * 86_400, now: h.now });
      const statement = identityStatement(binding);
      const local: LocalIdentityProof = { statement, evidence: await h.prove(statement), seed };
      const [alice, bob, carol] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
      const ledgers = new Map<string, IdentityLedger>();
      const sent: Record<string, unknown>[] = [];
      const peers = new Map<string, IdentityExchange>();
      const make2 = (me: string, them: string, context: string) => {
        const key = `${me}>${them}`;
        ledgers.set(key, emptyIdentityLedger());
        const x = new IdentityExchange({
          scope: () => ({ subject: me, audience: them, context, session: "c".repeat(64) }),
          send: frame => { sent.push(frame as Record<string, unknown>); queueMicrotask(() => void peers.get(`${them}>${me}`)?.receive(structuredClone(frame) as Record<string, unknown>)); },
          storage: { read: () => ledgers.get(key)!, update: async change => { ledgers.set(key, change(structuredClone(ledgers.get(key)!))); } },
          providers: () => [provider.id],
          localProof: id => (id === statement.id ? local : undefined),
          verify: (s, e) => verifyIdentity([provider], s, e, ctxOf(h)),
          now: () => h.now ?? Math.floor(Date.now() / 1000),
        });
        peers.set(key, x);
        return x;
      };
      const aliceToBob = make2(alice, bob, "a".repeat(64));
      make2(bob, alice, "a".repeat(64));
      make2(carol, alice, "b".repeat(64));
      await aliceToBob.share(statement.id, true);
      await vi.waitFor(() => expect(ledgers.get(`${alice}>${bob}`)!.shared[0]?.status).toBe("accepted"), { timeout });
      expect(ledgers.get(`${bob}>${alice}`)!.received).toHaveLength(1);
      expect(ledgers.get(`${carol}>${alice}`)!.received).toHaveLength(0);
      // Bob forwards what he received to Carol: no challenge of hers, wrong audience, and no proof key.
      const present = sent.find(f => f.t === "idp-present")!;
      await peers.get(`${carol}>${alice}`)!.receive({ t: "idp-request", id: statement.id, provider: provider.id });
      const challenge = sent.filter(f => f.t === "idp-challenge").at(-1)!;
      await peers.get(`${carol}>${alice}`)!.receive({ ...present, nonce: challenge.nonce, issuedAt: challenge.issuedAt });
      expect(ledgers.get(`${carol}>${alice}`)!.received).toHaveLength(0);
      expect(sent.at(-1)).toMatchObject({ t: "idp-result", ok: false });
    }, timeout);

    it("fails a re-check once revoked, when it can go stale", async () => {
      const h = await make();
      if (!h.provider.recheck) return;
      expect(h.revoke, "a provider with recheck must let the harness revoke").toBeTypeOf("function");
      const statement = statementFor(h);
      const evidence = await h.prove(statement);
      await verify(h, statement, evidence);
      await h.revoke!();
      await expect(verify(h, statement, evidence)).rejects.toThrow();
    }, timeout);
  });
}
