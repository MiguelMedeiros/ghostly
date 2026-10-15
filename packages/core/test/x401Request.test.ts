import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import { X401_PROTOCOLS, type X401DigitalRequest } from "../src/x401";
import { readX401OpenId4VpRequest, x401ApprovalDigest, type X401CertificateCheck, type X401RequestReading } from "../src/x401Request";
import { signedRequest } from "./support/x509";

const NOW = 1_760_000_000_000;
const URL_CALLED = "https://verifier.example/api/records";
const dcql = { credentials: [{ id: "licence", format: "dc+sd-jwt", meta: { vct_values: ["https://issuer.example/licence"] }, claims: [{ path: ["licence_number"] }] }] };
const params = { response_type: "vp_token", response_mode: "dc_api", nonce: "n-123", dcql_query: dcql };

const signer = p256.utils.randomSecretKey();
const leafKey = p256.getPublicKey(signer, false);
const LEAF = new Uint8Array([1, 2, 3]);

/** A certificate check that accepts the test leaf for any host, and records what it was asked. */
function certificates(publicKey = leafKey) {
  const asked: { chain: Uint8Array[]; host: string }[] = [];
  const check: X401CertificateCheck = async (chain, host) => { asked.push({ chain, host }); return { ok: true, publicKey }; };
  return { check, asked };
}

const unsigned = (data: Record<string, unknown> = params): X401DigitalRequest => ({ protocol: X401_PROTOCOLS.unsigned, data });
const signed = (payload: Record<string, unknown>, header: Record<string, unknown> = {}, key = signer): X401DigitalRequest =>
  ({ protocol: X401_PROTOCOLS.signed, data: { request: signedRequest(payload, key, [LEAF], header) } });
const jar = { ...params, client_id: "x509_san_dns:verifier.example", expected_origins: ["https://verifier.example"], exp: NOW / 1000 + 300 };

async function read(entry: X401DigitalRequest, url = URL_CALLED, check = certificates().check): Promise<X401RequestReading> {
  return readX401OpenId4VpRequest(entry, { url, certificates: check, now: NOW });
}
const refusal = async (entry: X401DigitalRequest, url?: string) => { const r = await read(entry, url); return r.ok ? "read" : `${r.reason}${r.detail ? `: ${r.detail}` : ""}`; };

describe("an unsigned OpenID4VP request", () => {
  it("is bound to the origin called, whatever client_id it carries", async () => {
    const r = await read(unsigned({ ...params, client_id: "x509_san_dns:bank.example", client_metadata: { a: 1 } }));
    expect(r.ok && r.value).toMatchObject({ signed: false, verifier: "origin:https://verifier.example", origin: "https://verifier.example", nonce: "n-123", responseMode: "dc_api", clientMetadata: { a: 1 } });
    expect(r.ok && r.value.dcql.credentials[0].id).toBe("licence");
  });

  it("refuses parameters it cannot answer", async () => {
    expect(await refusal(unsigned({ ...params, response_type: "code" }))).toBe("unsupported: response_type");
    expect(await refusal(unsigned({ ...params, response_mode: "direct_post" }))).toBe("unsupported: response_mode");
    expect(await refusal(unsigned({ ...params, nonce: "" }))).toBe("invalid: nonce");
    expect(await refusal(unsigned({ ...params, nonce: "n".repeat(513) }))).toBe("invalid: nonce");
    expect(await refusal(unsigned({ ...params, dcql_query: { credentials: [] } }))).toBe("invalid: dcql_query.credentials");
    expect(await refusal(unsigned({ ...params, client_metadata: [] }))).toBe("invalid: client_metadata");
  });

  it("is answered over https only, or http to a loopback host for a local verifier", async () => {
    expect(await refusal(unsigned(), "http://verifier.example/")).toBe("host: http: is not https:");
    expect(await refusal(unsigned(), "http://127.0.0.1:46400/")).toBe("read");
    const r = await read(unsigned(), "http://localhost:46400/x");
    expect(r.ok && r.value.verifier).toBe("origin:http://localhost:46400");
  });
});

describe("a signed OpenID4VP request", () => {
  it("reads a request for the host called, signed by its certificate's key", async () => {
    const { check, asked } = certificates();
    const r = await read(signed(jar), URL_CALLED, check);
    expect(r.ok && r.value).toMatchObject({ signed: true, verifier: "x509_san_dns:verifier.example", origin: "https://verifier.example", nonce: "n-123", expiresAt: NOW / 1000 + 300 });
    expect(asked).toEqual([{ chain: [LEAF], host: "verifier.example" }]);
  });

  it("refuses a request for another host before its certificate is looked at", async () => {
    const { check, asked } = certificates();
    const r = await read(signed({ ...jar, client_id: "x509_san_dns:bank.example" }), URL_CALLED, check);
    expect(r).toEqual({ ok: false, reason: "host", detail: "client_id names bank.example" });
    expect(asked).toEqual([]);
    expect(await refusal(signed({ ...jar, expected_origins: ["https://bank.example"] }))).toBe("host: expected_origins does not list https://verifier.example");
    expect(await refusal(signed(jar), "https://verifier.example:8443/x")).toBe("host: expected_origins does not list https://verifier.example:8443");
    expect(await refusal(signed({ ...jar, expected_origins: undefined }), "https://verifier.example:8443/x")).toBe("read");
  });

  it("refuses an expired request, a bad signature and a certificate the check refused", async () => {
    expect(await refusal(signed({ ...jar, exp: NOW / 1000 }))).toBe("expired");
    expect(await refusal(signed(jar, {}, p256.utils.randomSecretKey()))).toBe("signature");
    const other = certificates(p256.getPublicKey(p256.utils.randomSecretKey(), false)).check;
    expect((await read(signed(jar), URL_CALLED, other)).ok).toBe(false);
    const untrusted: X401CertificateCheck = async () => ({ ok: false, reason: "the chain leads to no trusted root" });
    expect(await read(signed(jar), URL_CALLED, untrusted)).toEqual({ ok: false, reason: "certificate", detail: "the chain leads to no trusted root" });
    const [head, , signature] = signedRequest(jar, signer, [LEAF]).split(".");
    const otherBody = signedRequest({ ...jar, nonce: "n-456" }, signer, [LEAF]).split(".")[1];
    expect(await refusal({ protocol: X401_PROTOCOLS.signed, data: { request: `${head}.${otherBody}.${signature}` } })).toBe("signature");
  });

  it("refuses what Ghostly does not answer", async () => {
    expect(await refusal(signed(jar, { alg: "RS256" }))).toBe("unsupported: alg RS256");
    expect(await refusal(signed(jar, { typ: "JWT" }))).toBe("invalid: typ");
    expect(await refusal(signed(jar, { crit: ["b64"] }))).toBe("unsupported: crit");
    expect(await refusal(signed({ ...jar, client_id: "redirect_uri:https://verifier.example/cb" }))).toBe("unsupported: client_id prefix redirect_uri");
    expect(await refusal(signed({ ...jar, client_id: undefined }))).toBe("invalid: client_id");
    expect(await refusal(signed(jar, { x5c: [] }))).toBe("invalid: x5c");
    expect(await refusal(signed(jar, { x5c: ["not base64!"] }))).toBe("invalid: x5c");
    expect(await refusal(signed({ ...jar, expected_origins: "https://verifier.example" }))).toBe("invalid: expected_origins");
    expect(await refusal({ protocol: X401_PROTOCOLS.signed, data: { request: "a.b" } })).toBe("invalid: data.request");
    expect(await refusal({ protocol: "openid4vp-v2", data: params })).toBe("unsupported: protocol openid4vp-v2");
  });
});

describe("the approval digest", () => {
  const subject = {
    verifier: "x509_san_dns:verifier.example",
    matches: [{ credential: "c1", claims: [["licence_number"], ["address", "country"]] }],
  };
  const digest = x401ApprovalDigest(subject);

  it("is the same for the same verifier, credential and claims in any order", () => {
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(x401ApprovalDigest({ ...subject, matches: [{ credential: "c1", claims: [["address", "country"], ["licence_number"]] }] })).toBe(digest);
  });

  it("changes with one claim more, another credential, another verifier or a token endpoint", () => {
    const changed = [
      { ...subject, matches: [{ credential: "c1", claims: [...subject.matches[0].claims, ["birth_date"]] }] },
      { ...subject, matches: [{ ...subject.matches[0], credential: "c2" }] },
      { ...subject, verifier: "origin:https://verifier.example" },
      { ...subject, tokenEndpoint: "https://verifier.example" },
    ].map(x401ApprovalDigest);
    expect(new Set([digest, ...changed]).size).toBe(5);
  });

  it("tells a claim path from a member whose name holds the path's separator", () => {
    expect(x401ApprovalDigest({ ...subject, matches: [{ credential: "c1", claims: [["a", "b"]] }] }))
      .not.toBe(x401ApprovalDigest({ ...subject, matches: [{ credential: "c1", claims: [["a\",\"b"]] }] }));
    expect(x401ApprovalDigest({ ...subject, matches: [{ credential: "c1", claims: [["a", 0]] }] }))
      .not.toBe(x401ApprovalDigest({ ...subject, matches: [{ credential: "c1", claims: [["a", "0"]] }] }));
  });
});
