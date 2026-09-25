import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode, type IdentityStatement } from "@ghostly/core";
import type { IdentityProofProvider } from "./contract";

/**
 * Fake identity providers, for unit tests and e2e. No network, no real accounts. They are in the
 * registry only when `localStorage["ghostly-test-identities"] === "1"` (or a test passes them itself).
 *
 *  - fake-key      self-custodied: an Ed25519 key held by a fake in-app signer, or signed "outside" and pasted.
 *  - fake-account  provider-attested: a fake issuer signs a token whose nonce is the statement id (like OIDC).
 *  - fake-record   self-custodied, published: a record the verifier fetches through `ctx.fetch` (like DNS).
 */
export const TEST_IDENTITIES_FLAG = "ghostly-test-identities";
export const testIdentitiesEnabled = () => { try { return globalThis.localStorage?.getItem(TEST_IDENTITIES_FLAG) === "1"; } catch { return false; } };

const HEX64 = /^[a-f0-9]{64}$/;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16));
const normalizeHexKey = (input: string) => { const v = input.trim().toLowerCase(); if (!HEX64.test(v)) throw new Error("Enter 64 hex characters"); return v; };
const exactKeys = (raw: unknown, keys: string) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;

/** The key behind the fake in-app signer. Tests may replace it. */
export const fakeKeyring = { seed: ed25519.utils.randomSecretKey() };
export const fakeKeySubject = (seed = fakeKeyring.seed) => hex(ed25519.getPublicKey(seed));
export const fakeKeySign = (statement: IdentityStatement, seed = fakeKeyring.seed) => ({ sig: toBase64Url(ed25519.sign(statement.bytes, seed)) });

export interface FakeKeyEvidence { sig: string }
export const fakeKey: IdentityProofProvider<FakeKeyEvidence> = {
  id: "fake-key", label: "Test key", category: "self-custodied",
  summary: "Sign with the test key", description: "A test identity: an Ed25519 key held by this page. For tests only.",
  platforms: ["web", "extension", "desktop"],
  subject: { label: "Public key", placeholder: "64 hex characters", normalize: normalizeHexKey, short: k => `${k.slice(0, 8)}…${k.slice(-4)}` },
  publicUri: k => `urn:ghostly-test:${k}`,
  validity: { defaultDays: 30, maxDays: 365 },
  privacy: "Nothing: checked on this device.",
  signers: [
    { id: "fake-signer", kind: "in-app", label: "Test signer", fields: [{ name: "refuse", label: "Refuse", kind: "text", optional: true }],
      run: async (ctx, work) => {
        ctx.signal.throwIfAborted();
        if (ctx.values.refuse) throw new Error("The test signer refused");
        return work({ subject: async () => fakeKeySubject(), sign: async statement => fakeKeySign(statement) });
      } },
    { id: "fake-tool", kind: "external-tool", label: "Sign outside Ghostly",
      instructions: statement => ({ steps: [{ text: "Sign this statement with your test key:", copy: statement.text }], paste: { label: "Signature (base64url)" } }),
      parse: pasted => { const sig = pasted.trim(); if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) throw new Error("That is not a test signature"); return { sig }; } },
  ],
  parseEvidence(raw) {
    const e = raw as FakeKeyEvidence;
    if (!exactKeys(raw, "sig") || typeof e.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(e.sig)) throw new Error("Invalid test evidence");
    return { sig: e.sig };
  },
  async verify(statement, evidence) {
    let ok: boolean;
    try { ok = ed25519.verify(fromBase64Url(evidence.sig), statement.bytes, unhex(statement.binding.subject)); } catch { ok = false; }
    if (!ok) throw new Error("Invalid test signature");
    return { subject: statement.binding.subject, source: "Test signature (Ed25519)" };
  },
};

/** The fake issuer's key. Its public half is what fake-account trusts, like a provider's JWKS. */
const ISSUER_SEED = unhex("7a".repeat(32));
export const FAKE_ISSUER = "https://issuer.ghostly.test";
export interface FakeAccountEvidence { token: string }
/** What the fake login page signs: iss, sub, nonce (= statement id), iat. */
export function fakeAccountToken(statement: IdentityStatement, account = "alice", seed = ISSUER_SEED, iat = statement.binding.issuedAt): FakeAccountEvidence {
  const payload = toBase64Url(utf8Encode(JSON.stringify({ iss: FAKE_ISSUER, sub: account, nonce: statement.id, iat })));
  return { token: `${payload}.${toBase64Url(ed25519.sign(utf8Encode(payload), seed))}` };
}
export const fakeAccount: IdentityProofProvider<FakeAccountEvidence> = {
  id: "fake-account", label: "Test account", category: "provider-attested",
  summary: "Log in to the test issuer", description: "A test login provider that vouches for an account. For tests only.",
  platforms: ["web", "extension", "desktop"],
  subject: { label: "Provider", options: [{ value: FAKE_ISSUER, label: "Test issuer" }],
    normalize: input => { if (input.trim() !== FAKE_ISSUER) throw new Error("Unknown test issuer"); return FAKE_ISSUER; } },
  validity: { defaultDays: 30, maxDays: 90 },
  privacy: "Nothing: the issuer's signature is checked on this device.",
  signers: [{ id: "fake-login", kind: "redirect", label: "Log in to the test issuer",
    start: async (statement, ctx) => { ctx.signal.throwIfAborted(); return fakeAccountToken(statement, ctx.values.account || "alice"); } }],
  parseEvidence(raw) {
    const e = raw as FakeAccountEvidence;
    if (!exactKeys(raw, "token") || typeof e.token !== "string" || e.token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(e.token)) throw new Error("Invalid test token");
    return { token: e.token };
  },
  async verify(statement, { token }) {
    const [payload, sig] = token.split(".");
    if (!ed25519.verify(fromBase64Url(sig), utf8Encode(payload), ed25519.getPublicKey(ISSUER_SEED))) throw new Error("Not signed by the test issuer");
    const claims = JSON.parse(utf8Decode(fromBase64Url(payload))) as { iss: string; sub: string; nonce: string };
    if (claims.iss !== statement.binding.subject) throw new Error("Token from another issuer");
    if (claims.nonce !== statement.id) throw new Error("Token for another statement");
    if (typeof claims.sub !== "string" || !/^[a-z0-9]{1,64}$/.test(claims.sub)) throw new Error("Invalid account");
    return { subject: `${claims.iss}#${claims.sub}`, attester: "issuer.ghostly.test", source: "Token signed by the test issuer",
      display: { name: claims.sub, source: "Test issuer profile", fetchedAt: statement.binding.issuedAt } };
  },
};

/** fake-record's records: subject → published text. The verifier reads `https://records.ghostly.test/<subject>`. */
export const FAKE_RECORD_HOST = "https://records.ghostly.test/";
export const fakeRecordText = (statement: IdentityStatement) => `ghostly-proof=${statement.id}`;
export const fakeRecord: IdentityProofProvider<Record<string, never>> = {
  id: "fake-record", label: "Test record", category: "self-custodied",
  summary: "Publish a test record", description: "A test record published where the verifier looks it up, like DNS. For tests only.",
  platforms: ["web", "extension", "desktop"],
  subject: { label: "Name", placeholder: "alice", normalize: input => { const v = input.trim().toLowerCase(); if (!/^[a-z0-9-]{1,63}$/.test(v)) throw new Error("Letters, digits and dashes"); return v; } },
  validity: { defaultDays: 30, maxDays: 365 },
  recheck: { afterSeconds: 3600 },
  privacy: "The verifier asks records.ghostly.test for the record: that server learns the name was checked.",
  signers: [{ id: "fake-publish", kind: "publish", label: "Publish a record",
    instructions: statement => ({ steps: [{ text: `Publish this record for ${statement.binding.subject}:`, copy: fakeRecordText(statement) }] }),
    evidence: () => ({}) }],
  parseEvidence(raw) { if (!exactKeys(raw, "")) throw new Error("Invalid test evidence"); return {}; },
  async verify(statement, _evidence, ctx) {
    const response = await ctx.fetch(`${FAKE_RECORD_HOST}${statement.binding.subject}`, { maxBytes: 4096, signal: ctx.signal });
    if (response.status !== 200 || !response.text.split("\n").includes(fakeRecordText(statement))) throw new Error("The record is not published");
    return { subject: statement.binding.subject, source: "Record published at records.ghostly.test" };
  },
};

export const FAKE_IDENTITY_PROVIDERS: readonly IdentityProofProvider[] = [fakeKey, fakeAccount, fakeRecord];
