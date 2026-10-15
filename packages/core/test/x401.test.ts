import { describe, expect, it } from "vitest";
import {
  X401_HEADERS, X401_LIMITS, buildX401ProofRequest, buildX401ProofResult, buildX401ResultArtifact, buildX401TokenObject, decodeX401Header,
  encodeX401Header, readX401ProofRequest, readX401ProofRequestHeader, readX401ProofResponseHeader, readX401ProofResultHeader,
  toBase64Url, utf8Encode, x401AnswerableRequests, type X401ProofRequest,
} from "../src/index";

// A JAR as the spec's Appendix A shows it, made whole: header {"alg":"ES256","typ":"oauth-authz-req+jwt"}, a payload, a signature.
const JAR = "eyJhbGciOiJFUzI1NiIsInR5cCI6Im9hdXRoLWF1dGh6LXJlcStqd3QifQ.eyJub25jZSI6Im4ifQ.c2ln";

/** x401 0.2.0, Appendix A (Minimal Payload). */
const MINIMAL = {
  scheme: "x401",
  version: "0.2.0",
  credential_requirements: { digital: { requests: [{ protocol: "openid4vp-v1-signed", data: { request: JAR } }] } },
  oauth: { token_endpoint: "https://bank.example.com/oauth/token" },
};

const UNSIGNED = { protocol: "openid4vp-v1-unsigned", data: { response_type: "vp_token", nonce: "n-1", dcql_query: { credentials: [] } } };

const header = (payload: unknown): string => toBase64Url(utf8Encode(JSON.stringify(payload)));
const headers = (name: string, ...values: string[]): Headers => {
  const h = new Headers();
  for (const v of values) h.append(name, v);
  return h;
};
const requestFrom = (payload: unknown) => readX401ProofRequestHeader(headers(X401_HEADERS.request, header(payload)));

describe("x401 PROOF-REQUEST", () => {
  it("reads the specification's minimal payload", () => {
    const read = requestFrom(MINIMAL);
    expect(read).toEqual({ ok: true, value: MINIMAL });
  });

  it("is null when the response has no proof request", () => {
    expect(readX401ProofRequestHeader(new Headers())).toBeNull();
  });

  it("keeps unknown members and the verifier's requirements as they came", () => {
    const payload = { ...MINIMAL, future: 1, credential_requirements: { ...MINIMAL.credential_requirements, mediation: "required" } };
    expect(requestFrom(payload)).toEqual({ ok: true, value: payload });
  });

  it("round-trips what buildX401ProofRequest writes", () => {
    const fields = {
      credential_requirements: { digital: { requests: [UNSIGNED] } },
      request_id: "age-over-18",
      satisfied_requirements: ["age"],
      payment: { required: false, notes: "free" },
    };
    const read = readX401ProofRequestHeader(headers(X401_HEADERS.request, buildX401ProofRequest(fields)));
    expect(read).toEqual({ ok: true, value: { scheme: "x401", version: "0.2.0", ...fields } });
  });

  it("refuses two header lines", () => {
    const value = header(MINIMAL);
    expect(readX401ProofRequestHeader(headers(X401_HEADERS.request, value, value))).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("refuses values joined with a comma", () => {
    expect(decodeX401Header(`${header(MINIMAL)},${header(MINIMAL)}`)).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("refuses a value over 16 KiB before it decodes it", () => {
    expect(decodeX401Header("A".repeat(X401_LIMITS.headerChars + 1))).toMatchObject({ ok: false, reason: "too-large" });
    const big = { ...MINIMAL, pad: "x".repeat(13_000) };
    expect(requestFrom(big)).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("refuses padded, standard-alphabet and non-canonical base64url", () => {
    const value = header(MINIMAL);
    expect(decodeX401Header(`${value}==`)).toMatchObject({ ok: false, reason: "bad-base64url" });
    expect(decodeX401Header("e3+/")).toMatchObject({ ok: false, reason: "bad-base64url" });
    expect(decodeX401Header("e30 x")).toMatchObject({ ok: false, reason: "bad-base64url" });
    // "e30" is "{}"; "e31" decodes to the same bytes with a non-zero trailing bit.
    expect(decodeX401Header("e30")).toEqual({ ok: true, value: {} });
    expect(decodeX401Header("e31")).toMatchObject({ ok: false, reason: "bad-base64url" });
    expect(decodeX401Header("")).toMatchObject({ ok: false, reason: "bad-base64url" });
  });

  it("refuses bytes that are not UTF-8, JSON that is not one object, and a byte order mark", () => {
    expect(decodeX401Header(toBase64Url(new Uint8Array([0x7b, 0xff, 0x7d])))).toMatchObject({ ok: false, reason: "not-object" });
    expect(decodeX401Header(header([MINIMAL]))).toMatchObject({ ok: false, reason: "not-object" });
    expect(decodeX401Header(header("x401"))).toMatchObject({ ok: false, reason: "not-object" });
    expect(decodeX401Header(header(null))).toMatchObject({ ok: false, reason: "not-object" });
    expect(decodeX401Header(toBase64Url(utf8Encode(String.fromCharCode(0xfeff) + JSON.stringify(MINIMAL))))).toMatchObject({ ok: false, reason: "not-object" });
  });

  it("refuses another scheme or any version but 0.2.0", () => {
    expect(requestFrom({ ...MINIMAL, scheme: "x402" })).toEqual({ ok: false, reason: "scheme", detail: "x402" });
    expect(requestFrom({ ...MINIMAL, version: "0.1.0" })).toEqual({ ok: false, reason: "version", detail: "0.1.0" });
    expect(requestFrom({ ...MINIMAL, version: "0.2" })).toMatchObject({ ok: false, reason: "version" });
    const { version: _, ...noVersion } = MINIMAL;
    expect(requestFrom(noVersion)).toEqual({ ok: false, reason: "version" });
  });

  it("refuses a malformed member and names it", () => {
    const cases: [unknown, string][] = [
      [{ ...MINIMAL, credential_requirements: {} }, "credential_requirements.digital"],
      [{ ...MINIMAL, credential_requirements: { digital: { requests: [] } } }, "credential_requirements.digital.requests"],
      [{ ...MINIMAL, credential_requirements: { digital: { requests: [{ protocol: "openid4vp-v1-unsigned" }] } } }, "credential_requirements.digital.requests[0]"],
      [{ ...MINIMAL, credential_requirements: { digital: { requests: [{ protocol: "openid4vp-v1-signed", data: { request: "not a jws" } }] } } }, "credential_requirements.digital.requests[0].data.request"],
      [{ ...MINIMAL, oauth: {} }, "oauth.token_endpoint"],
      [{ ...MINIMAL, oauth: { token_endpoint: "not a url" } }, "oauth.token_endpoint"],
      [{ ...MINIMAL, oauth: { ...MINIMAL.oauth, audience: 7 } }, "oauth.audience"],
      [{ ...MINIMAL, request_id: 1 }, "request_id"],
      [{ ...MINIMAL, satisfied_requirements: "age" }, "satisfied_requirements"],
      [{ ...MINIMAL, return_uri: "nowhere" }, "return_uri"],
      [{ ...MINIMAL, payment: { required: "yes" } }, "payment.required"],
    ];
    for (const [payload, detail] of cases) expect(requestFrom(payload)).toEqual({ ok: false, reason: "invalid", detail });
  });

  it("refuses a request with no OpenID4VP protocol of 0.2.0", () => {
    const payload = { ...MINIMAL, credential_requirements: { digital: { requests: [{ protocol: "org-iso-mdoc", data: {} }] } } };
    expect(requestFrom(payload)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("orders the answerable requests signed first and leaves other protocols out", () => {
    const signed = MINIMAL.credential_requirements.digital.requests[0]!;
    const other = { protocol: "org-iso-mdoc", data: {} };
    const read = requestFrom({ ...MINIMAL, credential_requirements: { digital: { requests: [UNSIGNED, other, signed] } } });
    expect(read?.ok).toBe(true);
    expect(x401AnswerableRequests((read as { value: X401ProofRequest }).value)).toEqual([signed, UNSIGNED]);
  });

  it("reads a payload object without going through a header", () => {
    expect(readX401ProofRequest(MINIMAL)).toEqual({ ok: true, value: MINIMAL });
  });
});

describe("x401 PROOF-RESPONSE", () => {
  const responseFrom = (value: string) => readX401ProofResponseHeader(headers(X401_HEADERS.response, value));
  const result = { protocol: "openid4vp-v1-signed", data: { vp_token: { pid: ["eyJ...~"] } } };

  it("round-trips an inline Result Artifact", () => {
    const value = buildX401ResultArtifact(result, { request_id: "age-over-18", expires_at: "2026-10-15T18:00:00Z" });
    expect(responseFrom(value)).toEqual({
      ok: true,
      value: { kind: "artifact", artifact: { credential_result: result, request_id: "age-over-18", expires_at: "2026-10-15T18:00:00Z" } },
    });
  });

  it("round-trips a Token Object", () => {
    expect(responseFrom(buildX401TokenObject("tok-1"))).toEqual({
      ok: true,
      value: { kind: "token", token: { scheme: "x401", version: "0.2.0", token_type: "Bearer", access_token: "tok-1" } },
    });
  });

  it("reads a Result Artifact by reference", () => {
    const value = header({ credential_result_uri: "https://agent.example/r/1" });
    expect(responseFrom(value)).toMatchObject({ ok: true, value: { kind: "artifact" } });
  });

  it("wants exactly one of credential_result and credential_result_uri", () => {
    expect(responseFrom(header({}))).toEqual({ ok: false, reason: "invalid", detail: "credential_result" });
    expect(responseFrom(header({ credential_result: result, credential_result_uri: "https://agent.example/r/1" })))
      .toEqual({ ok: false, reason: "invalid", detail: "credential_result" });
    expect(responseFrom(header({ credential_result_uri: "http://agent.example/r/1" })))
      .toEqual({ ok: false, reason: "invalid", detail: "credential_result_uri" });
    expect(responseFrom(header({ credential_result: result, expires_at: "tomorrow" })))
      .toEqual({ ok: false, reason: "invalid", detail: "expires_at" });
  });

  it("refuses a token of another type, version or without its value", () => {
    const token = { scheme: "x401", version: "0.2.0", token_type: "Bearer", access_token: "t" };
    expect(responseFrom(header({ ...token, token_type: "DPoP" }))).toEqual({ ok: false, reason: "invalid", detail: "token_type" });
    expect(responseFrom(header({ ...token, access_token: "" }))).toEqual({ ok: false, reason: "invalid", detail: "access_token" });
    expect(responseFrom(header({ ...token, version: "0.3.0" }))).toMatchObject({ ok: false, reason: "version" });
  });
});

describe("x401 PROOF-RESULT", () => {
  const resultFrom = (value: string) => readX401ProofResultHeader(headers(X401_HEADERS.result, value));

  it("round-trips an error object", () => {
    const fields = { error: "invalid_result", error_description: "The proof did not verify.", request_id: "age-over-18" };
    expect(resultFrom(buildX401ProofResult(fields))).toEqual({ ok: true, value: { scheme: "x401", version: "0.2.0", ...fields } });
  });

  it("refuses an error code that is not short ASCII, and an error_uri that is not https", () => {
    const base = { scheme: "x401", version: "0.2.0" };
    expect(resultFrom(header({ ...base, error: "bad result" }))).toEqual({ ok: false, reason: "invalid", detail: "error" });
    expect(resultFrom(header(base))).toEqual({ ok: false, reason: "invalid", detail: "error" });
    expect(resultFrom(header({ ...base, error: "x", error_uri: "http://v.example/e" }))).toEqual({ ok: false, reason: "invalid", detail: "error_uri" });
  });

  it("encodes every header as base64url without padding", () => {
    expect(encodeX401Header({ a: "~~~" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
