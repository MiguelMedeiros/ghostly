import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { identityStatement, newIdentityBinding, type IdentityStatement } from "@ghostly/core";
import { IDENTITY_PROVIDERS, identityProvider, identityProviders } from "../src/proofs/registry";
import { boundedIdentityFetch, descriptorProblems, verifyIdentity } from "../src/proofs/verify";
import { fakeAccount, fakeKey, FAKE_ISSUER, TEST_IDENTITIES_FLAG } from "../src/proofs/testing";
import { nostr, type NostrEvent } from "../src/proofs/providers/nostr";
import type { IdentityProofProvider, InAppSigner, VerifyContext } from "../src/proofs/contract";
import { signNostr } from "./helpers/nostrSign";
// @ts-expect-error Native fixture is deliberately directly executable JavaScript.
import { startTestBunker } from "./helpers/nostrBunker.mjs";
// covers: proofs.contract, proofs.nostr, nostr.signer

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const ctx = (): VerifyContext => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch: async () => { throw new Error("no network"); } });
const statementOf = (provider: string, subject: string, days = 30) => identityStatement(newIdentityBinding({ provider, subject, validitySeconds: days * 86_400 }).binding);
const signerCtx = (values: Record<string, string> = {}) => ({ values, signal: new AbortController().signal, onAuthUrl: vi.fn(), onProgress: vi.fn() });

describe("identity provider registry", () => {
  it("lists well-formed providers with unique ids, fakes only when asked for", () => {
    for (const p of IDENTITY_PROVIDERS) expect(descriptorProblems(p), p.id).toEqual([]);
    expect(new Set(IDENTITY_PROVIDERS.map(p => p.id)).size).toBe(IDENTITY_PROVIDERS.length);
    expect(identityProviders().map(p => p.id)).not.toContain("fake-key");
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === TEST_IDENTITIES_FLAG ? "1" : null) });
    try { expect(identityProviders().map(p => p.id)).toEqual([...IDENTITY_PROVIDERS.map(p => p.id), "fake-key", "fake-account", "fake-record"]); }
    finally { vi.unstubAllGlobals(); }
    expect(identityProvider("nostr")).toBe(nostr);
    expect(identityProvider("unknown")).toBeUndefined();
  });

  it("reports what is wrong with a descriptor", () => {
    const broken = { ...fakeKey, id: "Bad Id", privacy: "", validity: { defaultDays: 10, maxDays: 5 }, signers: [fakeKey.signers[0], fakeKey.signers[0]] } as IdentityProofProvider;
    expect(descriptorProblems(broken)).toEqual(expect.arrayContaining([expect.stringMatching(/^id/), expect.stringMatching(/^privacy/), expect.stringMatching(/^validity/), expect.stringMatching(/unique/)]));
  });
});

describe("verifyIdentity: the checks every provider gets", () => {
  it("refuses a provider this app does not know", async () => {
    const s = statementOf("unknown", "x");
    await expect(verifyIdentity([fakeKey as IdentityProofProvider], s, {}, ctx())).rejects.toThrow(/cannot verify/);
  });
  it("holds a self-custodied provider to its subject, an attested one to naming its attester", async () => {
    const liar: IdentityProofProvider = { ...fakeKey, verify: async () => ({ subject: "0".repeat(64), source: "x" }) } as IdentityProofProvider;
    const s = statementOf("fake-key", "1".repeat(64));
    await expect(verifyIdentity([liar], s, { sig: "A".repeat(86) }, ctx())).rejects.toThrow(/another identity/);
    const anonymous: IdentityProofProvider = { ...fakeAccount, verify: async () => ({ subject: "x", source: "y" }) } as IdentityProofProvider;
    await expect(verifyIdentity([anonymous], statementOf("fake-account", FAKE_ISSUER), { token: "a.".padEnd(88, "A") }, ctx())).rejects.toThrow(/attests/);
  });
});

describe("the Nostr provider", () => {
  const secret = schnorr.utils.randomSecretKey(), pubkey = hex(schnorr.getPublicKey(secret));
  it("accepts npub or hex and keeps hex", () => {
    expect(nostr.subject.normalize(npubEncode(pubkey))).toBe(pubkey);
    expect(nostr.subject.normalize(pubkey.toUpperCase())).toBe(pubkey);
    expect(() => nostr.subject.normalize("nsec1abc")).toThrow(/npub/);
    expect(nostr.subject.short!(pubkey)).toMatch(/^npub1.{5}….{4}$/);
  });
  it("refuses a valid signature over another event: extra tag, other kind, other content", async () => {
    const s = statementOf("nostr", pubkey);
    const resign = (change: Partial<NostrEvent>) => {
      const template = { ...signNostr(s, secret), ...change };
      const fake = { ...s, text: template.content, binding: { ...s.binding, issuedAt: template.created_at } } as IdentityStatement;
      return signNostr({ ...fake }, secret);
    };
    for (const e of [resign({ content: s.text + " " }), resign({ created_at: s.binding.issuedAt + 1 })])
      await expect(nostr.verify(s, e, ctx())).rejects.toThrow(/exact Ghostly statement/);
    const good = signNostr(s, secret);
    await expect(nostr.verify(s, { ...good, sig: "0".repeat(128) }, ctx())).rejects.toThrow(/signature/);
    await expect(nostr.verify(s, { ...good, id: "0".repeat(64) }, ctx())).rejects.toThrow(/id/);
  });
  it("signs through a NIP-07 extension in the page and verifies", async () => {
    const signEvent = vi.fn();
    const nip07 = nostr.signers.find(x => x.id === "nip07") as InAppSigner<NostrEvent>;
    let statement: IdentityStatement | undefined;
    vi.stubGlobal("nostr", { getPublicKey: async () => pubkey, signEvent: async (template: { content: string }) => { signEvent(template); return signNostr(statement!, secret); } });
    try {
      expect(nip07.available!()).toBe(true);
      const event = await nip07.run(signerCtx(), async session => {
        const subject = await session.subject();
        statement = statementOf("nostr", subject);
        return session.sign(statement);
      });
      expect(signEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 30078, content: statement!.text }));
      expect(await verifyIdentity([nostr as IdentityProofProvider], statement!, JSON.parse(JSON.stringify(event)), ctx())).toMatchObject({ subject: pubkey });
    } finally { vi.unstubAllGlobals(); }
    expect(nip07.available!()).toBe(false);
  });
  it("signs through a NIP-46 remote signer and verifies", async () => {
    const fixture = await startTestBunker();
    try {
      const nip46 = nostr.signers.find(x => x.id === "nip46") as InAppSigner<NostrEvent>;
      let statement!: IdentityStatement;
      const event = await nip46.run(signerCtx({ bunker: fixture.bunker }), async session => {
        statement = statementOf("nostr", await session.subject());
        return session.sign(statement);
      });
      expect(statement.binding.subject).toBe(fixture.userPub);
      expect(await verifyIdentity([nostr as IdentityProofProvider], statement, event, ctx())).toMatchObject({ subject: fixture.userPub });
    } finally { await fixture.close(); }
  });
});

describe("the engine's bounded fetch", () => {
  const response = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers });
  it("refuses offline, http and credentials in the URL, and caps the size", async () => {
    const fetcher = vi.fn(async () => response("x".repeat(100)));
    await expect(boundedIdentityFetch({ online: () => false, fetcher })("https://a.test/")).rejects.toThrow(/Offline/);
    const f = boundedIdentityFetch({ online: () => true, fetcher });
    await expect(f("http://a.test/")).rejects.toThrow(/HTTPS/);
    await expect(f("https://u:p@a.test/")).rejects.toThrow(/HTTPS/);
    await expect(f("https://a.test/", { maxBytes: 10 })).rejects.toThrow(/too large/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends no credentials or referrer, refuses redirects by default, and returns text and raw bytes", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response("été", { "content-type": "text/plain" }));
    const r = await boundedIdentityFetch({ online: () => true, fetcher: fetcher as unknown as typeof fetch })("https://a.test/x");
    expect(r).toMatchObject({ status: 200, contentType: "text/plain", text: "été" });
    expect(Array.from(r.bytes)).toEqual([0xc3, 0xa9, 0x74, 0xc3, 0xa9]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    await boundedIdentityFetch({ online: () => true, fetcher: fetcher as unknown as typeof fetch })("https://a.test/x", { redirect: "follow" });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "follow" });
  });
});
