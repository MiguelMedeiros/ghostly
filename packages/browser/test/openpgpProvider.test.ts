import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as pgp from "openpgp";
import { identityStatement, IDENTITY_MAX_EVIDENCE, newIdentityBinding, type IdentityStatement } from "@ghostly/core";
import { openpgp, normalizeFingerprint } from "../src/proofs/providers/openpgp";
import { preparePgpEvidence, type PgpEvidence } from "../src/proofs/openpgp";
import { identityProvider, IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { verifyIdentity } from "../src/proofs/verify";
import type { ExternalToolSigner, IdentityProofProvider, VerifyContext } from "../src/proofs/contract";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { fingerprints as fpr, hasGpg, TestGpg, vector } from "./helpers/gpg";

// Test keys made by GnuPG (test/vectors/openpgp/generate.sh), used here to sign statements built at run time.
const secret = (name: string) => pgp.readPrivateKey({ armoredKey: vector(`${name}.sec.asc`) });
async function clearsign(name: string, text: string, date?: Date): Promise<string> {
  return pgp.sign({ message: await pgp.createCleartextMessage({ text }), signingKeys: await secret(name), date });
}
const [gpgSigner, keyserverSigner] = openpgp.signers as readonly ExternalToolSigner<PgpEvidence>[];
const day = 86_400;
const statementAt = (subject: string, now = Math.floor(Date.now() / 1000), days = 90) =>
  identityStatement(newIdentityBinding({ provider: "openpgp", subject, validitySeconds: days * day, now }).binding);
const ctx = (now = Math.floor(Date.now() / 1000)): VerifyContext => ({ now, signal: new AbortController().signal, fetch: async url => { throw new Error(`no network: ${url}`); } });
const verify = (s: IdentityStatement, evidence: unknown, now?: number) => verifyIdentity([openpgp as IdentityProofProvider], s, JSON.parse(JSON.stringify(evidence)), ctx(now));
/** Evidence for a statement by whatever key signed it, without the check the gpg signer makes on the fingerprint. */
const evidenceBy = async (name: string, s: IdentityStatement, date?: Date) =>
  (await preparePgpEvidence({ statement: s.text, signature: await clearsign(name, s.text, date), publicKey: vector(`${name}.pub.asc`) }, date ? { now: Math.floor(date.getTime() / 1000) } : {})).evidence;

describeIdentityProof("OpenPGP (Ed25519 signing subkey)", async () => ({
  provider: openpgp, subject: fpr.alice,
  prove: async s => gpgSigner.parse(`${await clearsign("alice", s.text)}\n${vector("alice.pub.asc")}`, s) as Promise<PgpEvidence>,
  proveAsOther: s => evidenceBy("bob", s),
}));

describeIdentityProof("OpenPGP (RSA 3072)", async () => ({
  provider: openpgp, subject: fpr.bob,
  prove: async s => gpgSigner.parse(`${await clearsign("bob", s.text)}\n${vector("bob.pub.asc")}`, s) as Promise<PgpEvidence>,
  proveAsOther: s => evidenceBy("alice", s),
}), { timeout: 20_000 });

// The contract once more with the real thing: GnuPG runs the exact commands the instructions give.
if (hasGpg) {
  let gpg: TestGpg;
  beforeAll(() => { gpg = new TestGpg(["alice"]); });
  afterAll(() => gpg.close());
  describeIdentityProof("OpenPGP (GnuPG, run as the instructions say)", async () => ({
    provider: openpgp, subject: fpr.alice,
    prove: s => gpgSigner.parse(`${gpg.clearsign(fpr.alice, s.text)}\n${gpg.exportKey(fpr.alice)}`, s) as Promise<PgpEvidence>,
    proveAsOther: s => evidenceBy("bob", s),
  }), { timeout: 20_000 });
} else it.skip("OpenPGP contract with GnuPG: gpg is not installed here", () => {});

describe("OpenPGP provider", () => {
  it("is registered", () => {
    expect(IDENTITY_PROVIDERS.map(p => p.id)).toContain("openpgp");
    expect(identityProvider("openpgp")).toBe(openpgp);
  });

  it("takes a fingerprint however gpg prints it, and refuses key IDs", () => {
    expect(normalizeFingerprint(` 0x${fpr.alice.toLowerCase().replace(/(.{4})/g, "$1 ")} `)).toBe(fpr.alice);
    expect(() => normalizeFingerprint(fpr.alice.slice(-16))).toThrow(/not a key ID/);
    expect(() => normalizeFingerprint("alice@example.org")).toThrow(/fingerprint/);
    expect(openpgp.subject.short!(fpr.alice)).toMatch(/^…([A-F0-9]{4} ){3}[A-F0-9]{4}$/);
  });

  it("gives commands that sign exactly the statement with the named key", () => {
    const s = statementAt(fpr.alice);
    const { steps, paste } = gpgSigner.instructions(s);
    expect(steps[0].copy).toBe(`printf '%s' '${s.text}' > ghostly-identity.txt`);
    expect(steps[1].copy).toBe(`gpg --local-user ${fpr.alice} --clearsign --output - ghostly-identity.txt && gpg --armor --export --export-options export-minimal ${fpr.alice}`);
    expect(steps.at(-1)!.copy).toBe(s.text);
    expect(paste).toMatchObject({ multiline: true });
    expect(keyserverSigner.instructions(s).steps[1].copy).toBe(`gpg --local-user ${fpr.alice} --clearsign --output - ghostly-identity.txt`);
  });

  it("says how it checked, and shows the key's user ID only with its caveat", async () => {
    const s = statementAt(fpr.alice);
    const verified = await verify(s, await evidenceBy("alice", s));
    expect(verified).toEqual({ subject: fpr.alice, source: "OpenPGP signature (Ed25519 signing subkey, v4 key)",
      display: { name: "Alice Test <alice@example.org>", source: expect.stringMatching(/written by its holder: not proof that the name or email is theirs/), fetchedAt: expect.any(Number) } });
  });

  it("ends when the key expires, if that is before the proof does", async () => {
    const signedAt = Date.UTC(2026, 1, 1) / 1000, keyExpiry = Date.UTC(2026, 5, 1, 12) / 1000;
    const s = statementAt(fpr.expired, signedAt, 365);
    const evidence = await evidenceBy("expired", s, new Date(signedAt * 1000));
    await expect(verify(s, evidence, signedAt + day)).resolves.toMatchObject({ expiresAt: keyExpiry });
    await expect(verify(s, evidence, keyExpiry + day)).rejects.toThrow(/expired on 2026-06-01/);
  });

  it("refuses another statement, another key, a revoked key", async () => {
    const s = statementAt(fpr.alice);
    await expect(gpgSigner.parse(`${await clearsign("alice", statementAt(fpr.alice).text)}\n${vector("alice.pub.asc")}`, s)).rejects.toThrow(/different text/);
    await expect(gpgSigner.parse(`${await clearsign("bob", s.text)}\n${vector("bob.pub.asc")}`, s)).rejects.toThrow(/not the one the statement names/);
    await expect(verify(s, await evidenceBy("bob", s))).rejects.toThrow(/not the one the statement names/);
    const revoked = statementAt(fpr.revoked);
    const signature = await clearsign("revoked", revoked.text, new Date(Date.UTC(2026, 0, 1)));
    await expect(gpgSigner.parse(`${signature}\n${vector("revoked.pub.asc")}`, revoked)).rejects.toThrow(/revoked/);
  });

  it("refuses a signature older than the statement", async () => {
    const s = statementAt(fpr.alice);
    await expect(gpgSigner.parse(`${await clearsign("alice", s.text, new Date((s.binding.issuedAt - 3600) * 1000))}\n${vector("alice.pub.asc")}`, s)).rejects.toThrow(/older than/);
  });

  it("asks for the public key in the gpg signer's paste, and never looks it up there", async () => {
    const s = statementAt(fpr.alice);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      await expect(gpgSigner.parse(await clearsign("alice", s.text), s)).rejects.toThrow(/public key too/);
      await expect(gpgSigner.parse(`${vector("alice.sec.asc")}`, s)).rejects.toThrow(/PRIVATE key/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("fetches the key from keys.openpgp.org only in the signer that says so", async () => {
    const s = statementAt(fpr.alice);
    const fetch = vi.fn(async () => new Response(vector("alice.pub.asc")));
    vi.stubGlobal("fetch", fetch);
    try {
      const evidence = await keyserverSigner.parse(await clearsign("alice", s.text), s);
      expect(fetch).toHaveBeenCalledWith(`https://keys.openpgp.org/vks/v1/by-fingerprint/${fpr.alice}`, expect.objectContaining({ credentials: "omit" }));
      await expect(verify(s, evidence)).resolves.toMatchObject({ subject: fpr.alice });
    } finally { vi.unstubAllGlobals(); }
  });

  it("looks up keys.openpgp.org's confirmed emails on request, labelled as its check, and reports a revocation there", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(vector("alice.pub.asc"))));
    try {
      await expect(openpgp.lookupDisplay!(fpr.alice, { signal: new AbortController().signal })).resolves.toMatchObject({
        name: "alice@example.org", url: `https://keys.openpgp.org/search?q=${fpr.alice}`, source: expect.stringMatching(/keys\.openpgp\.org.*the keyserver's check, not Ghostly's/) });
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(vector("revoked.pub.asc"))));
    try { await expect(openpgp.lookupDisplay!(fpr.revoked, { signal: new AbortController().signal })).rejects.toThrow(/revoked/); }
    finally { vi.unstubAllGlobals(); }
  });

  it("fits a large key in the contract's evidence limit: RSA 4096 with eight user IDs", async () => {
    const userIDs = Array.from({ length: 8 }, (_, i) => ({ name: `Big Key ${i}`, email: `big${i}@example.org` }));
    const { privateKey, publicKey } = await pgp.generateKey({ type: "rsa", rsaBits: 4096, userIDs, format: "object" });
    const s = statementAt(publicKey.getFingerprint().toUpperCase());
    const signature = await pgp.sign({ message: await pgp.createCleartextMessage({ text: s.text }), signingKeys: privateKey });
    const evidence = await gpgSigner.parse(`${signature}\n${publicKey.armor()}`, s);
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(IDENTITY_MAX_EVIDENCE);
    await expect(verify(s, evidence)).resolves.toMatchObject({ source: expect.stringContaining("RSA 4096") });
  }, 60_000);
});
