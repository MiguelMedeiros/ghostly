import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import {
  createIdentity, createRelayPayload, didGhostlyServiceEntry, didWebFile, identityStatement, newIdentityBinding, sign, toBase64Url, utf8Encode,
  type IdentityStatement,
} from "@ghostly/core";
import type { IdentityFetch, IdentityFetchOptions, IdentityProofProvider, VerifyContext } from "../src/proofs/contract";
import { did, setOwnDidSource, type DidEvidence } from "../src/proofs/providers/did";
import { clearDidCache, resolveDid } from "../src/proofs/did";
import { clearDomainCache } from "../src/proofs/domain";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { verifyIdentity } from "../src/proofs/verify";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { answerDoh, queryFromUrl, type Zone } from "./helpers/dohZone";
// covers: proofs.did, proofs.contract

const b64u = (b: Uint8Array) => toBase64Url(b);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const json64 = (v: unknown) => b64u(utf8Encode(JSON.stringify(v)));
const signer = did.signers.find(s => s.id === "sign")!;
if (signer.kind !== "external-tool") throw new Error("the sign signer pastes back");

/** A key on a curve, as its did:key, its JWK, and the signatures people paste. */
function keyOn(curve: "Ed25519" | "secp256k1" | "P-256") {
  const lib = curve === "Ed25519" ? ed25519 : curve === "secp256k1" ? secp256k1 : p256;
  const secret = lib.utils.randomSecretKey();
  const pub = curve === "Ed25519" ? ed25519.getPublicKey(secret) : (lib as typeof p256).getPublicKey(secret, true);
  const full = curve === "Ed25519" ? pub : (lib as typeof p256).getPublicKey(secret, false);
  const prefix = { Ed25519: [0xed, 0x01], secp256k1: [0xe7, 0x01], "P-256": [0x80, 0x24] }[curve];
  const alg = { Ed25519: "EdDSA", secp256k1: "ES256K", "P-256": "ES256" }[curve];
  const jwk = curve === "Ed25519" ? { kty: "OKP", crv: "Ed25519", x: b64u(pub) } : { kty: "EC", crv: curve, x: b64u(full.slice(1, 33)), y: b64u(full.slice(33)) };
  const raw = (m: Uint8Array) => (curve === "Ed25519" ? ed25519.sign(m, secret) : (lib as typeof p256).sign(m, secret));
  const jws = (statement: string, header: Record<string, unknown> = {}) => {
    const h = json64({ alg, ...header });
    const payload = b64u(utf8Encode(statement));
    return `${h}.${payload}.${b64u(raw(utf8Encode(`${h}.${payload}`)))}`;
  };
  return { curve, jwk, multibase: `z${base58.encode(Uint8Array.from([...prefix, ...pub]))}`, didKey: `did:key:z${base58.encode(Uint8Array.from([...prefix, ...pub]))}`, didJwk: `did:jwk:${json64(jwk)}`, raw, jws, alg };
}

const HOST = "id.example.com";
const WEB = `did:web:${HOST}`;

/** What a contact's app sees for a did:web: a DoH resolver and the domain's web server, with every fetch recorded. */
function webNetwork(host = HOST) {
  const zone: Zone = { a: { [host]: ["203.0.113.7"] }, txt: {}, ttl: 0 };
  const files = new Map<string, string | { status: number }>();
  const asked: { url: string; options?: IdentityFetchOptions }[] = [];
  const fetch: IdentityFetch = async (url, options) => {
    asked.push({ url, options });
    if (url.startsWith("https://dns.quad9.net/dns-query?")) return { status: 200, contentType: "application/dns-message", text: "", bytes: answerDoh(queryFromUrl(url), zone) };
    const u = new URL(url);
    if (u.hostname !== host) throw new TypeError("Failed to fetch");
    const body = files.get(u.pathname);
    if (body === undefined) return { status: 404, contentType: "text/plain", text: "", bytes: new Uint8Array() };
    if (typeof body !== "string") return { status: body.status, contentType: "text/plain", text: "", bytes: new Uint8Array() };
    const bytes = utf8Encode(body);
    if (bytes.length > (options?.maxBytes ?? 64 * 1024)) throw new Error("Identity check response too large");
    return { status: 200, contentType: "application/json", text: body, bytes };
  };
  return { zone, files, fetch, asked };
}

const document = (id: string, methods: { fragment: string; jwk: object; rel?: ("authentication" | "assertionMethod")[] }[], extra: object = {}) => ({
  "@context": ["https://www.w3.org/ns/did/v1"],
  id,
  verificationMethod: methods.map(m => ({ id: `${id}#${m.fragment}`, type: "JsonWebKey2020", controller: id, publicKeyJwk: m.jwk })),
  authentication: methods.filter(m => (m.rel ?? ["authentication"]).includes("authentication")).map(m => `#${m.fragment}`),
  assertionMethod: methods.filter(m => (m.rel ?? ["assertionMethod"]).includes("assertionMethod")).map(m => `${id}#${m.fragment}`),
  ...extra,
});

const ctxOf = (fetch: IdentityFetch): VerifyContext => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch });
const statementFor = (subject: string) => identityStatement(newIdentityBinding({ provider: "did", subject, validitySeconds: 90 * 86_400 }).binding);
const refuse: IdentityFetch = async url => { throw new Error(`Unexpected network access: ${url}`); };

beforeEach(() => { clearDidCache(); clearDomainCache(); });
afterEach(() => { vi.restoreAllMocks(); setOwnDidSource(() => undefined); });

// A did:key or did:jwk cannot change, so nothing can fail a re-check: the contract runs without `recheck` for them.
const fixed: IdentityProofProvider<DidEvidence> = { ...did, recheck: undefined };

describeIdentityProof("DID (did:key, Ed25519 JWS)", async () => {
  const k = keyOn("Ed25519"), other = keyOn("Ed25519");
  return {
    provider: fixed, subject: k.didKey,
    prove: async s => signer.parse(k.jws(s.text), s) as Promise<DidEvidence>,
    proveAsOther: async s => ({ method: "jws", vm: `${k.didKey}#${k.multibase}`, jws: other.jws(s.text) }),
  };
});

describeIdentityProof("DID (did:jwk, P-256 raw signature)", async () => {
  const k = keyOn("P-256"), other = keyOn("P-256");
  return {
    provider: fixed, subject: k.didJwk,
    prove: async s => signer.parse(hex(k.raw(utf8Encode(s.text))), s) as Promise<DidEvidence>,
    proveAsOther: async s => ({ method: "sig", vm: `${k.didJwk}#0`, sig: b64u(other.raw(utf8Encode(s.text))) }),
  };
});

describeIdentityProof("DID (did:web, secp256k1 JWS; a key removed stops counting)", async () => {
  const net = webNetwork(), k = keyOn("secp256k1"), other = keyOn("secp256k1");
  net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "key-1", jwk: k.jwk }])));
  return {
    provider: did, subject: WEB, fetch: net.fetch,
    prove: async s => ({ method: "jws", vm: `${WEB}#key-1`, jws: k.jws(s.text, { kid: `${WEB}#key-1` }) }),
    proveAsOther: async s => ({ method: "jws", vm: `${WEB}#key-1`, jws: other.jws(s.text) }),
    revoke: () => { net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "key-2", jwk: other.jwk }]))); clearDidCache(); },
  };
});

describeIdentityProof("DID (did:web, a file beside did.json)", async () => {
  const net = webNetwork(), k = keyOn("Ed25519");
  net.files.set("/user/alice/did.json", JSON.stringify(document(`${WEB}:user:alice`, [{ fragment: "k", jwk: k.jwk }])));
  const published: string[] = [];
  return {
    provider: did, subject: `${WEB}:user:alice`, fetch: net.fetch,
    prove: async s => { net.files.set(`/user/alice/ghostly/${s.id}.json`, didWebFile(s.binding.subject, s.text)); published.push(s.id); return { method: "file" }; },
    // Someone else's statement at this proof's address.
    proveAsOther: async s => { net.files.set(`/user/alice/ghostly/${s.id}.json`, didWebFile(s.binding.subject, s.text.replace("Nonce:", "Nonce: x"))); return { method: "file" }; },
    revoke: () => { for (const id of published) net.files.delete(`/user/alice/ghostly/${id}.json`); clearDidCache(); },
  };
});

describeIdentityProof("DID (did:web, a service in did.json)", async () => {
  const net = webNetwork(), k = keyOn("Ed25519");
  const services: object[] = [];
  const write = () => net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "k", jwk: k.jwk }], { service: services })));
  write();
  return {
    provider: did, subject: WEB, fetch: net.fetch,
    prove: async s => { services.push(didGhostlyServiceEntry(WEB, s.binding.key, s.id)); write(); clearDidCache(); return { method: "service" }; },
    proveAsOther: async s => { services.length = 0; services.push(didGhostlyServiceEntry(WEB, createIdentity().pubKeyZ32, s.id)); write(); clearDidCache(); return { method: "service" }; },
    revoke: () => { services.length = 0; write(); clearDidCache(); },
  };
});

/** A did:dht published on a relay the way Pkarr clients do: its identity key signs the packet. */
function dhtNetwork() {
  const identity = createIdentity();
  const didDht = `did:dht:${identity.pubKeyZ32}`;
  let payload: Uint8Array | undefined;
  const publish = (keys: { id: string; t: number; k: Uint8Array }[], auth: string[]) => {
    payload = createRelayPayload(identity, [
      { label: "_did", value: `v=0;vm=${keys.map((_, i) => `k${i}`).join(",")};auth=${auth.join(",")};asm=${auth.join(",")}` },
      ...keys.map((key, i) => ({ label: `_k${i}._did`, value: `id=${key.id};t=${key.t};k=${b64u(key.k)}` })),
    ]);
  };
  const fetch: IdentityFetch = async url => {
    if (url !== `https://pkarr.pubky.org/${identity.pubKeyZ32}`) return { status: 404, contentType: "", text: "", bytes: new Uint8Array() };
    return payload ? { status: 200, contentType: "application/pkarr.org/relays#payload", text: "", bytes: payload } : { status: 404, contentType: "", text: "", bytes: new Uint8Array() };
  };
  const identityKey = identity.publicKey;
  return { identity, didDht, publish, fetch, identityKey };
}

describeIdentityProof("DID (did:dht, the identity key's raw signature)", async () => {
  const net = dhtNetwork(), other = createIdentity();
  net.publish([{ id: "0", t: 0, k: net.identityKey }], ["k0"]);
  return {
    provider: did, subject: net.didDht, fetch: net.fetch,
    prove: async s => ({ method: "sig", vm: `${net.didDht}#0`, sig: b64u(sign(utf8Encode(s.text), net.identity.seed)) }),
    proveAsOther: async s => ({ method: "sig", vm: `${net.didDht}#0`, sig: b64u(sign(utf8Encode(s.text), other.seed)) }),
    revoke: () => { net.publish([{ id: "0", t: 0, k: net.identityKey }, { id: "backup", t: 0, k: other.publicKey }], ["k1"]); clearDidCache(); },
  };
});

describe("the DID provider", () => {
  it("is registered, advanced, and previews a subject before anything is signed", () => {
    expect(IDENTITY_PROVIDERS.map(p => p.id)).toContain("did");
    expect(did.advanced).toBe(true);
    expect(did.subject.preview).toBeTypeOf("function");
  });

  it("refuses this profile's own Ghostly did:dht, by name", () => {
    const mine = `did:dht:${createIdentity().pubKeyZ32}`;
    setOwnDidSource(() => mine);
    expect(() => did.subject.normalize(mine)).toThrow(/own Ghostly DID/);
    expect(did.subject.normalize(`did:dht:${createIdentity().pubKeyZ32}`)).toMatch(/^did:dht:/);
  });

  it("names unsupported methods, and writes DIDs short", () => {
    expect(() => did.subject.normalize("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toThrow(/did:plc is not supported yet/);
    const k = keyOn("Ed25519");
    expect(did.subject.short!(k.didKey)).toMatch(/^did:key:z6Mk.{4}…/);
    expect(did.subject.short!(`${WEB}:users:a-rather-long-name`)).toBe(`did:web:${HOST}:…`);
    expect(did.subject.short!(WEB)).toBe(WEB);
  });

  it("previews did:key offline: its method and key, and only signing applies", async () => {
    const k = keyOn("P-256");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network for a did:key"));
    const preview = await did.subject.preview!(k.didKey, { signal: new AbortController().signal });
    expect(Object.fromEntries(preview.facts.map(f => [f.label, f.value]))).toMatchObject({ Method: "did:key, the key is the identifier", Key: expect.stringMatching(/\(P-256\)$/) });
    expect(preview.signers).toEqual(["sign"]);
  });

  it("previews did:web: domain, document and keys; publishing applies, and alone when no key can sign", async () => {
    const net = webNetwork(), k = keyOn("Ed25519");
    net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "key-1", jwk: k.jwk }, { fragment: "agree", jwk: keyOn("P-256").jwk, rel: [] }])));
    const global = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const r = await net.fetch(String(input));
      return new Response(r.bytes.length ? r.bytes : null, { status: r.status, headers: { "content-type": r.contentType } });
    });
    const preview = await did.subject.preview!(WEB, { signal: new AbortController().signal });
    expect(Object.fromEntries(preview.facts.map(f => [f.label, f.value]))).toEqual({
      Method: "did:web", Domain: HOST, Document: `https://${HOST}/.well-known/did.json`, Key: "#key-1 (Ed25519)",
      "Not usable": "1 key: another curve, or not for authentication or assertionMethod",
    });
    expect(preview.signers).toEqual(["sign", "file", "service"]);
    expect(global).toHaveBeenCalled();
    clearDidCache();
    net.files.set("/.well-known/did.json", JSON.stringify({ id: WEB }));
    expect((await did.subject.preview!(WEB, { signal: new AbortController().signal })).signers).toEqual(["file", "service"]);
  });

  it("refuses a DID that cannot sign at all", async () => {
    const edEnc = `did:jwk:${json64({ ...keyOn("Ed25519").jwk, use: "enc" })}`;
    await expect(did.subject.preview!(edEnc, { signal: new AbortController().signal })).rejects.toThrow(/cannot sign/);
  });

  it("pastes back JWS and raw signatures in every shape, and records the key that signed", async () => {
    for (const curve of ["Ed25519", "secp256k1", "P-256"] as const) {
      const k = keyOn(curve);
      const s = statementFor(k.didKey);
      const vm = `${k.didKey}#${k.multibase}`;
      const jws = k.jws(s.text);
      expect(await signer.parse(`${jws.slice(0, 40)}\n${jws.slice(40)}\n`, s)).toEqual({ method: "jws", vm, jws });
      const sig = k.raw(utf8Encode(s.text));
      expect(await signer.parse(`#${k.multibase} ${hex(sig)}`, s)).toEqual({ method: "sig", vm, sig: b64u(sig) });
      if (curve !== "Ed25519") {
        const der = (curve === "secp256k1" ? secp256k1 : p256).Signature.fromBytes(sig, "compact").toBytes("der");
        expect(await signer.parse(btoa(String.fromCharCode(...der)), s)).toEqual({ method: "sig", vm, sig: b64u(sig) });
      }
      await expect(verifyIdentity([did], s, await signer.parse(hex(sig), s), ctxOf(refuse))).resolves.toMatchObject({ subject: k.didKey, source: expect.stringContaining("did:key") });
    }
  });

  it("refuses a signature by a key the DID does not list for authentication or assertionMethod", async () => {
    const net = webNetwork(), k = keyOn("Ed25519");
    net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "delegate", jwk: k.jwk, rel: [] }])));
    const s = statementFor(WEB);
    const evidence: DidEvidence = { method: "jws", vm: `${WEB}#delegate`, jws: k.jws(s.text) };
    await expect(verifyIdentity([did], s, evidence, ctxOf(net.fetch))).rejects.toThrow(/not list under authentication or assertionMethod/);
  });

  it("refuses evidence naming another key than the one that signed, and publishing for a did:key", async () => {
    const net = webNetwork(), a = keyOn("Ed25519"), b = keyOn("Ed25519");
    net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "a", jwk: a.jwk }, { fragment: "b", jwk: b.jwk }])));
    const s = statementFor(WEB);
    await expect(verifyIdentity([did], s, { method: "jws", vm: `${WEB}#b`, jws: a.jws(s.text) }, ctxOf(net.fetch))).rejects.toThrow(/another key/);
    const k = keyOn("Ed25519");
    await expect(verifyIdentity([did], statementFor(k.didKey), { method: "file" }, ctxOf(refuse))).rejects.toThrow(/did:web/);
    expect(() => (did.signers.find(x => x.id === "file") as { instructions(s: IdentityStatement): unknown }).instructions(statementFor(k.didKey))).toThrow(/did:web only/);
  });

  it("parses evidence strictly", () => {
    const vm = `${WEB}#k`;
    for (const bad of [
      { method: "jws", vm, jws: "x".repeat(5000) }, { method: "jws", vm: "#k", jws: "a.b.c" }, { method: "sig", vm, sig: "abc" },
      { method: "file", extra: 1 }, { method: "dns" }, { method: "sig", vm, sig: "A".repeat(86), x: 1 },
    ]) expect(() => did.parseEvidence(bad), JSON.stringify(bad).slice(0, 60)).toThrow(/not DID proof evidence/);
    expect(did.parseEvidence({ method: "service" })).toEqual({ method: "service" });
  });

  it("writes instructions for the DID's own curve: jose, @noble/curves and OpenSSL, with the exact statement", () => {
    const ed = keyOn("Ed25519"), secp = keyOn("secp256k1");
    const s = statementFor(ed.didKey);
    const steps = (signer as { instructions(s: IdentityStatement): { steps: { text: string; copy?: string }[] } }).instructions(s).steps;
    expect(steps[0].copy).toBe(s.text);
    expect(steps.map(x => x.copy ?? "").join("\n")).toMatch(/CompactSign[\s\S]*kid: "did:key:[\s\S]*@noble\/curves\/ed25519\.js[\s\S]*openssl pkeyutl -sign -rawin/);
    const secpSteps = (signer as { instructions(s: IdentityStatement): { steps: { text: string; copy?: string }[] } }).instructions(statementFor(secp.didKey)).steps;
    expect(secpSteps.map(x => x.copy ?? "").join("\n")).not.toMatch(/jose/);
    expect(secpSteps.map(x => x.copy ?? "").join("\n")).toMatch(/secp256k1\.js[\s\S]*openssl dgst -sha256 -sign/);
  });
});

describe("resolving a did:web", () => {
  const k = keyOn("Ed25519");
  const opts = (fetch: IdentityFetch) => ({ fetch, signal: new AbortController().signal });

  it("asks for did.json without following redirects, and refuses one", async () => {
    const net = webNetwork();
    net.files.set("/.well-known/did.json", { status: 301 } as never);
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/redirect/);
    expect(net.asked.filter(a => !a.url.includes("dns-query")).every(a => a.options?.redirect === "error")).toBe(true);
  });

  it("refuses a domain pointing to a private address, without contacting it", async () => {
    const net = webNetwork();
    net.zone.a = { [HOST]: ["10.0.0.8"] };
    net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "k", jwk: k.jwk }])));
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/private network/);
    expect(net.asked.some(a => a.url.startsWith(`https://${HOST}/`))).toBe(false);
  });

  it("refuses an oversize document, a missing one, one that is not JSON, and one for another DID", async () => {
    const net = webNetwork();
    net.files.set("/.well-known/did.json", JSON.stringify({ ...document(WEB, [{ fragment: "k", jwk: k.jwk }]), pad: "x".repeat(70 * 1024) }));
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/too large/);
    net.files.delete("/.well-known/did.json");
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/No DID document at https:\/\/id\.example\.com\/\.well-known\/did\.json/);
    net.files.set("/.well-known/did.json", "<html>");
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/not JSON/);
    net.files.set("/.well-known/did.json", JSON.stringify(document("did:web:evil.example.org", [{ fragment: "k", jwk: k.jwk }])));
    await expect(resolveDid(WEB, opts(net.fetch))).rejects.toThrow(/another DID/);
  });

  it("shares one lookup between back-to-back checks", async () => {
    const net = webNetwork();
    net.files.set("/.well-known/did.json", JSON.stringify(document(WEB, [{ fragment: "k", jwk: k.jwk }])));
    await Promise.all([resolveDid(WEB, opts(net.fetch)), resolveDid(WEB, opts(net.fetch))]);
    await resolveDid(WEB, opts(net.fetch));
    expect(net.asked.filter(a => a.url.endsWith("/did.json"))).toHaveLength(1);
  });
});

describe("resolving a did:dht", () => {
  it("reads the signed record's keys, and refuses one signed by another key or deactivated", async () => {
    const net = dhtNetwork();
    net.publish([{ id: "0", t: 0, k: net.identityKey }], ["k0"]);
    const found = await resolveDid(net.didDht, { fetch: net.fetch });
    expect(found.document.keys.map(k => [k.id, k.curve, k.relationships])).toEqual([[`${net.didDht}#0`, "Ed25519", ["authentication", "assertionMethod"]]]);
    expect(found.relay).toBe("https://pkarr.pubky.org");
    clearDidCache();
    const forged: IdentityFetch = async (url, o) => { const r = await net.fetch(url, o); const bytes = r.bytes.slice(); bytes[0] ^= 1; return { ...r, bytes }; };
    await expect(resolveDid(net.didDht, { fetch: forged })).rejects.toThrow(/not signed by the DID's key/);
    clearDidCache();
    const deactivated = async () => ({ document: {}, metadata: { versionId: "1", updated: "", deactivated: true as const }, relay: "x" });
    await expect(resolveDid(net.didDht, { fetch: net.fetch, dht: deactivated })).rejects.toThrow(/deactivated/);
  });
});
