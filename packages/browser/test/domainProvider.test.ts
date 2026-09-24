import { beforeEach, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  createIdentity, domainTxtRecord, domainWellKnownFile, identityStatement, newIdentityBinding, type DomainRecord, type IdentityStatement,
} from "@ghostly/core";
import type { IdentityFetch, VerifyContext } from "../src/proofs/contract";
import { domain, type DomainEvidence } from "../src/proofs/providers/domain";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { verifyIdentity } from "../src/proofs/verify";
import { clearDomainCache } from "../src/proofs/domain";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { answerDoh, queryFromUrl, type Zone } from "./helpers/dohZone";
import { signNostr } from "./helpers/nostrSign";
// covers: proofs.domain.dns, proofs.domain.https, proofs.contract

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const recordFor = (s: IdentityStatement): DomainRecord => ({ key: s.binding.key, proof: s.id });
const SUBJECT = "proofs.example.com";

/** The network a contact's app sees: a DoH resolver answering from `zone`, and the domain's web server. */
function testNetwork() {
  // TTL 0: a re-check right after a change must see it, as the contract suite expects.
  const zone: Zone = { a: { [SUBJECT]: ["203.0.113.7"] }, txt: {}, ttl: 0 };
  const files = new Map<string, string>();
  const asked: string[] = [];
  const fetch: IdentityFetch = async (url, options) => {
    asked.push(url);
    if (options?.redirect === "follow") throw new Error("A domain proof must never follow redirects");
    const bytes = (body: string | Uint8Array) => typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (url.startsWith("https://dns.quad9.net/dns-query?")) {
      const b = answerDoh(queryFromUrl(url), zone);
      return { status: 200, contentType: "application/dns-message", text: "", bytes: b };
    }
    const u = new URL(url);
    if (u.hostname !== SUBJECT) throw new TypeError("Failed to fetch");
    const body = files.get(u.pathname + u.search);
    return body === undefined ? { status: 404, contentType: "text/plain", text: "", bytes: new Uint8Array() }
      : { status: 200, contentType: "application/json", text: body, bytes: bytes(body) };
  };
  return { zone, files, fetch, asked, txt: (records: DomainRecord[]) => { zone.txt = { [`_ghostly.${SUBJECT}`]: records.map(domainTxtRecord) }; } };
}

beforeEach(() => clearDomainCache());

describeIdentityProof("Domain (DNS TXT)", async () => {
  const net = testNetwork(), published: DomainRecord[] = [];
  return {
    provider: domain, subject: SUBJECT, fetch: net.fetch,
    prove: async s => { published.push(recordFor(s)); net.txt(published); return { method: "dns" }; },
    // Someone else's record under the domain: evidence for this statement must not verify.
    proveAsOther: async () => { net.txt([{ key: createIdentity().pubKeyZ32, proof: hex(crypto.getRandomValues(new Uint8Array(32))) }]); return { method: "dns" }; },
    revoke: () => { published.length = 0; net.txt([]); },
  };
});

describeIdentityProof("Domain (/.well-known/ghostly.json)", async () => {
  const net = testNetwork(), published: DomainRecord[] = [];
  const write = () => published.length ? net.files.set("/.well-known/ghostly.json", domainWellKnownFile(published.slice(-8))) : net.files.delete("/.well-known/ghostly.json");
  return {
    provider: domain, subject: SUBJECT, fetch: net.fetch,
    prove: async s => { published.push(recordFor(s)); write(); return { method: "https" }; },
    proveAsOther: async () => { published.length = 0; published.push({ key: createIdentity().pubKeyZ32, proof: hex(crypto.getRandomValues(new Uint8Array(32))) }); write(); return { method: "https" }; },
    revoke: () => { published.length = 0; write(); },
  };
});

describeIdentityProof("Domain (NIP-05)", async () => {
  const net = testNetwork();
  const mine = schnorr.utils.randomSecretKey(), other = schnorr.utils.randomSecretKey();
  net.files.set("/.well-known/nostr.json?name=_", JSON.stringify({ names: { _: hex(schnorr.getPublicKey(mine)) } }));
  return {
    provider: domain, subject: SUBJECT, fetch: net.fetch,
    prove: async s => ({ method: "nip05", event: signNostr(s, mine) }),
    // A valid Nostr signature, by a key the domain does not name.
    proveAsOther: async s => ({ method: "nip05", event: signNostr(s, other) }),
    revoke: () => { net.files.clear(); },
  };
});

describe("domain provider", () => {
  const statement = (subject = SUBJECT) => identityStatement(newIdentityBinding({ provider: "domain", subject, validitySeconds: 90 * 86_400 }).binding);
  const ctx = (fetch: IdentityFetch): VerifyContext => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch });

  it("is registered", () => {
    expect(IDENTITY_PROVIDERS.map(p => p.id)).toContain("domain");
  });

  it("tells the person exactly what to publish, with copyable name, value, file and header", () => {
    const s = statement();
    const [dns, https] = domain.signers;
    if (dns.kind !== "publish" || https.kind !== "publish") throw new Error("publish signers first");
    const dnsSteps = dns.instructions(s).steps;
    expect(dnsSteps.map(x => x.copy).filter(Boolean)).toEqual([`_ghostly.${SUBJECT}`, `v=ghostly1; key=${s.binding.key}; proof=${s.id}`]);
    const httpsSteps = https.instructions(s).steps;
    expect(httpsSteps.map(x => x.copy).filter(Boolean)).toEqual([
      `https://${SUBJECT}/.well-known/ghostly.json`,
      domainWellKnownFile([recordFor(s)]),
      "Access-Control-Allow-Origin: *",
    ]);
    expect(dns.evidence(s)).toEqual({ method: "dns" });
    expect(https.evidence(s)).toEqual({ method: "https" });
  });

  it("normalizes what the person types, and refuses names only a private network has", () => {
    expect(domain.subject.normalize(" Proofs.Example.COM. ")).toBe(SUBJECT);
    for (const bad of ["localhost", "nas.local", "10.0.0.1", "example.com/x", "intranet"]) expect(() => domain.subject.normalize(bad)).toThrow();
  });

  it("says how it checked, including the resolver and DNSSEC", async () => {
    const net = testNetwork(), s = statement();
    net.txt([recordFor(s)]);
    net.zone.dnssec = true;
    const verified = await verifyIdentity([domain], s, { method: "dns" }, ctx(net.fetch));
    expect(verified).toEqual({ subject: SUBJECT, source: `DNS TXT record at _ghostly.${SUBJECT}, via Quad9, DNSSEC validated` });
    expect(net.asked).toHaveLength(1);
  });

  it("does not contact a web server whose domain points into a private network", async () => {
    const net = testNetwork(), s = statement();
    net.zone.a = { [SUBJECT]: ["192.168.0.10"] };
    net.files.set("/.well-known/ghostly.json", domainWellKnownFile([recordFor(s)]));
    await expect(verifyIdentity([domain], s, { method: "https" }, ctx(net.fetch))).rejects.toThrow(/private network/);
    expect(net.asked.some(u => u.startsWith(`https://${SUBJECT}/`))).toBe(false);
  });

  it("refuses a statement whose domain is not canonical, before any lookup", async () => {
    const net = testNetwork();
    const s = identityStatement({ ...newIdentityBinding({ provider: "domain", subject: SUBJECT, validitySeconds: 86_400 }).binding, subject: "Proofs.Example.com" });
    await expect(verifyIdentity([domain], s, { method: "dns" }, ctx(net.fetch))).rejects.toThrow(/canonical/);
    expect(net.asked).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ["an unknown method", { method: "ftp" }],
    ["a DNS proof carrying extra data", { method: "dns", url: "https://evil.example/" }],
    ["NIP-05 without its event", { method: "nip05" }],
    ["NIP-05 with a broken event", { method: "nip05", event: { id: "x" } }],
    ["a string", "dns"],
  ])("refuses %s as evidence", (_, raw) => {
    expect(() => domain.parseEvidence(raw)).toThrow();
  });

  it("refuses a NIP-05 proof whose domain names another Nostr key", async () => {
    const net = testNetwork(), s = statement();
    const signer = schnorr.utils.randomSecretKey();
    net.files.set("/.well-known/nostr.json?name=_", JSON.stringify({ names: { _: "f".repeat(64), someone: hex(schnorr.getPublicKey(signer)) } }));
    const evidence: DomainEvidence = { method: "nip05", event: signNostr(s, signer) };
    await expect(verifyIdentity([domain], s, evidence, ctx(net.fetch))).rejects.toThrow(/another Nostr key/);
  });

  it("refuses a NIP-05 event signed over another statement, before any lookup", async () => {
    const net = testNetwork(), s = statement();
    const signer = schnorr.utils.randomSecretKey();
    const evidence: DomainEvidence = { method: "nip05", event: signNostr(statement(), signer) };
    await expect(verifyIdentity([domain], s, evidence, ctx(net.fetch))).rejects.toThrow();
    expect(net.asked).toHaveLength(0);
  });
});
