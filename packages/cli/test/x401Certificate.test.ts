import { describe, expect, it } from "vitest";
import { X401_PROTOCOLS } from "../../core/src/x401";
import { readX401OpenId4VpRequest } from "../../core/src/x401Request";
import { EKU, KEY_USAGE, pem, signedRequest, testCertificate } from "../../core/test/support/x509";
import { x401CertificateCheck } from "../src/x401Certificate";

const now = Date.now();
const root = testCertificate({ subject: "Test Root", ca: true });
const intermediate = testCertificate({ subject: "Test Intermediate", ca: true, issuer: root });
const leaf = testCertificate({ subject: "verifier.example", dns: ["verifier.example", "api.verifier.example"], issuer: intermediate });
const check = x401CertificateCheck([pem(root)]);
const reason = async (chain: Uint8Array[], host = "verifier.example") => {
  const r = await check(chain, host, now);
  return r.ok ? "ok" : r.reason;
};

describe("the certificate check of a signed x401 request", () => {
  it("takes a chain to a trusted root whose leaf names the host, and gives the leaf's key", async () => {
    expect(await check([leaf.der, intermediate.der], "verifier.example", now)).toEqual({ ok: true, publicKey: leaf.publicKey });
    expect(await reason([leaf.der, intermediate.der], "api.verifier.example")).toBe("ok");
    expect(await reason([leaf.der, intermediate.der, root.der])).toBe("ok");
  });

  it("refuses a leaf that does not name the host, even in its common name", async () => {
    expect(await reason([leaf.der, intermediate.der], "bank.example")).toBe("the leaf certificate does not name bank.example");
    const cnOnly = testCertificate({ subject: "verifier.example", issuer: intermediate });
    expect(await reason([cnOnly.der, intermediate.der])).toBe("the leaf certificate does not name verifier.example");
  });

  it("refuses a chain to an untrusted root, one that does not link, and one out of its validity", async () => {
    const otherRoot = testCertificate({ subject: "Other Root", ca: true });
    const stranger = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: otherRoot });
    expect(await reason([stranger.der])).toBe("the chain leads to no trusted root");
    expect(await reason([stranger.der, otherRoot.der])).toBe("the chain leads to no trusted root");
    expect(await reason([stranger.der, intermediate.der])).toBe("the chain does not link");
    const notCa = testCertificate({ subject: "Test Intermediate", issuer: root });
    const underNotCa = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: notCa });
    expect(await reason([underNotCa.der, notCa.der])).toBe("the chain does not link");
    const old = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: intermediate, notAfter: now - 1000 });
    expect(await reason([old.der, intermediate.der])).toMatch(/^a certificate is not valid now/);
    expect(await reason([new Uint8Array([0x30, 0x00])])).toBe("a certificate does not parse");
    expect(await reason([intermediate.der, root.der], "verifier.example")).toBe("the leaf certificate is a CA");
  });

  it("refuses a chain longer than a CA's path length allows", async () => {
    const lastCa = testCertificate({ subject: "Issuing CA", ca: true, pathLen: 0, issuer: root });
    const rogue = testCertificate({ subject: "Rogue CA", ca: true, issuer: lastCa });
    const under = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: rogue });
    expect(await reason([under.der, rogue.der, lastCa.der])).toBe("a CA's path length does not allow this chain (Issuing CA)");
    const direct = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: lastCa });
    expect(await reason([direct.der, lastCa.der])).toBe("ok");
    const narrowRoot = testCertificate({ subject: "Narrow Root", ca: true, pathLen: 0 });
    const throughRoot = testCertificate({ subject: "Middle CA", ca: true, issuer: narrowRoot });
    const leafOfRoot = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: throughRoot });
    expect((await x401CertificateCheck([pem(narrowRoot)])([leafOfRoot.der, throughRoot.der], "verifier.example", now)).ok).toBe(false);
  });

  it("refuses a leaf outside a CA's name constraints", async () => {
    const constrained = testCertificate({ subject: "Constrained CA", ca: true, issuer: root, names: { permitted: [".allowed.example"], excluded: ["no.allowed.example"] } });
    const inside = (dns: string) => testCertificate({ subject: dns, dns: [dns], issuer: constrained });
    expect(await reason([inside("api.allowed.example").der, constrained.der], "api.allowed.example")).toBe("ok");
    expect(await reason([inside("bank.example").der, constrained.der], "bank.example")).toBe("the leaf certificate names bank.example, outside its CA's name constraints (Constrained CA)");
    expect(await reason([inside("x.no.allowed.example").der, constrained.der], "x.no.allowed.example")).toMatch(/outside its CA's name constraints/);
    // A name the host does not need is still a name the CA vouches for.
    const extra = testCertificate({ subject: "api.allowed.example", dns: ["api.allowed.example", "bank.example"], issuer: constrained });
    expect(await reason([extra.der, constrained.der], "api.allowed.example")).toMatch(/names bank.example, outside/);
    const exact = testCertificate({ subject: "Exact CA", ca: true, issuer: root, names: { permitted: ["verifier.example"] } });
    const sub = testCertificate({ subject: "api.verifier.example", dns: ["api.verifier.example"], issuer: exact });
    expect(await reason([sub.der, exact.der], "api.verifier.example")).toBe("ok");
    const near = testCertificate({ subject: "notverifier.example", dns: ["notverifier.example"], issuer: exact });
    expect(await reason([near.der, exact.der], "notverifier.example")).toMatch(/outside its CA's name constraints/);
  });

  it("refuses a leaf whose key usages do not allow signing a request", async () => {
    const leafWith = (o: { keyUsage?: number[]; eku?: (readonly number[])[] }) =>
      testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: intermediate, ...o }).der;
    expect(await reason([leafWith({ keyUsage: [KEY_USAGE.keyAgreement] }), intermediate.der])).toBe("the leaf certificate's key usage does not allow signing");
    expect(await reason([leafWith({ keyUsage: [KEY_USAGE.digitalSignature] }), intermediate.der])).toBe("ok");
    expect(await reason([leafWith({ eku: [EKU.emailProtection] }), intermediate.der])).toBe("a certificate's extended key usage is not for servers");
    expect(await reason([leafWith({ eku: [EKU.clientAuth, EKU.serverAuth] }), intermediate.der])).toBe("ok");
    expect(await reason([leafWith({ eku: [EKU.any] }), intermediate.der])).toBe("ok");
    const mailCa = testCertificate({ subject: "Mail CA", ca: true, issuer: root, eku: [EKU.emailProtection] });
    const underMail = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: mailCa });
    expect(await reason([underMail.der, mailCa.der])).toBe("a certificate's extended key usage is not for servers");
  });

  it("refuses a certificate with a critical extension it does not know, and takes an unknown one that is not critical", async () => {
    const strange = { oid: [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x99, 0x01] };
    const critical = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: intermediate, extensions: [{ ...strange, critical: true }] });
    expect(await reason([critical.der, intermediate.der])).toBe("a certificate has a critical extension this check does not know (verifier.example)");
    const plain = testCertificate({ subject: "verifier.example", dns: ["verifier.example"], issuer: intermediate, extensions: [{ ...strange, critical: false }] });
    expect(await reason([plain.der, intermediate.der])).toBe("ok");
  });

  it("trusts no test root by default", async () => {
    expect((await x401CertificateCheck()([leaf.der, intermediate.der, root.der], "verifier.example", now)).ok).toBe(false);
  });

  it("lets a signed request through only when its leaf certificate signed it", async () => {
    const payload = {
      response_type: "vp_token", response_mode: "dc_api", nonce: "n-1", client_id: "x509_san_dns:verifier.example",
      expected_origins: ["https://verifier.example"], exp: Math.floor(now / 1000) + 60,
      dcql_query: { credentials: [{ id: "q", format: "dc+sd-jwt" }] },
    };
    const entry = (secret: Uint8Array) => ({ protocol: X401_PROTOCOLS.signed, data: { request: signedRequest(payload, secret, [leaf.der, intermediate.der]) } });
    const context = { url: "https://verifier.example/records", certificates: check, now };
    const r = await readX401OpenId4VpRequest(entry(leaf.secret), context);
    expect(r.ok && r.value.verifier).toBe("x509_san_dns:verifier.example");
    expect(await readX401OpenId4VpRequest(entry(intermediate.secret), context)).toEqual({ ok: false, reason: "signature" });
  });
});
