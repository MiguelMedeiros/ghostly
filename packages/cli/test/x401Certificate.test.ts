import { describe, expect, it } from "vitest";
import { X401_PROTOCOLS } from "../../core/src/x401";
import { readX401OpenId4VpRequest } from "../../core/src/x401Request";
import { pem, signedRequest, testCertificate } from "../../core/test/support/x509";
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
