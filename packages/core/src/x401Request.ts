import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { X401_PROTOCOLS, type X401DigitalRequest } from "./x401";
import type { X401ClaimPath } from "./x401Credential";
import { readX401DcqlQuery, type X401DcqlMatch, type X401DcqlQuery } from "./x401Presentation";

/*
 * The OpenID4VP request an x401 agent answers (WISP 3xx, Answering a proof request, step 3), and the digest its person
 * approves (Approval). A CLI has no browser origin: the origin of the URL it called stands in for one.
 *
 * - Unsigned (`openid4vp-v1-unsigned`): the parameters themselves. No `client_id` is read: the verifier is the origin
 *   called, and the Key Binding JWT's `aud` is `origin:<origin>` (OpenID4VP 1.0, Appendix A).
 * - Signed (`openid4vp-v1-signed`): a JAR. ES256 only, `client_id` `x509_san_dns:<host called>`, the leaf certificate
 *   of `x5c` signs it, the chain is checked by the caller's `certificates` (the CLI checks it against the system's
 *   roots), `exp` has not passed, and `expected_origins`, when given, lists the origin called.
 *
 * Nothing here fetches or asks anyone. A request is refused with a reason before its query is matched.
 */

export const X401_REQUEST_LIMITS = {
  /** Certificates in `x5c`. */
  chain: 8,
  /** Characters of a `nonce`. */
  nonce: 512,
  expectedOrigins: 32,
} as const;

export const X401_RESPONSE_MODES = ["dc_api", "dc_api.jwt"] as const;
export type X401ResponseMode = typeof X401_RESPONSE_MODES[number];

/** A request the agent may answer, as read and checked. */
export interface X401OpenId4VpRequest {
  signed: boolean;
  /** The verifier: the signed request's `client_id`, else `origin:<origin called>`. Also the Key Binding JWT's `aud`. */
  verifier: string;
  /** The origin called. */
  origin: string;
  nonce: string;
  dcql: X401DcqlQuery;
  /** `dc_api.jwt` asks for an encrypted response, to a key in `client_metadata`. */
  responseMode: X401ResponseMode;
  clientMetadata?: Record<string, unknown>;
  /** The signed request's `exp`, in seconds. */
  expiresAt?: number;
}

export type X401RequestRefusal =
  /** A member is missing or has the wrong shape; `detail` names it. */
  | "invalid"
  /** A signature algorithm, `client_id` prefix, `response_type` or `response_mode` Ghostly does not answer. */
  | "unsupported"
  | "expired"
  /** The request names another host or origin than the one called. */
  | "host"
  /** The certificate chain was not accepted; `detail` says why. */
  | "certificate"
  | "signature";

export type X401RequestReading = { ok: true; value: X401OpenId4VpRequest } | { ok: false; reason: X401RequestRefusal; detail?: string };

/**
 * Checks a signed request's `x5c` chain (DER, leaf first) for a host at a time: that it leads to a trusted root, that
 * each certificate is valid then, and that a DNS name of the leaf is that host. Gives the leaf's P-256 public key,
 * uncompressed.
 */
export type X401CertificateCheck = (chain: Uint8Array[], host: string, now: number) =>
  Promise<{ ok: true; publicKey: Uint8Array } | { ok: false; reason: string }>;

export interface X401RequestContext {
  /** The URL the agent called; its origin and host bind the request. */
  url: string;
  certificates: X401CertificateCheck;
  now?: number;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (reason: X401RequestRefusal, detail?: string): { ok: false; reason: X401RequestRefusal; detail?: string } =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

function decodeJson(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("not base64url");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(part)));
}

/** The parameters both kinds share: `response_type`, `response_mode`, `nonce`, `dcql_query`, `client_metadata`. */
function readParameters(params: JsonObject, origin: string, verifier: string, signed: boolean): X401RequestReading {
  if (params.response_type !== "vp_token") return refuse("unsupported", "response_type");
  const mode = params.response_mode;
  if (!X401_RESPONSE_MODES.includes(mode as X401ResponseMode)) return refuse("unsupported", "response_mode");
  const nonce = params.nonce;
  if (typeof nonce !== "string" || !nonce || nonce.length > X401_REQUEST_LIMITS.nonce) return refuse("invalid", "nonce");
  const dcql = readX401DcqlQuery(params.dcql_query);
  if (!dcql.ok) return refuse("invalid", `dcql_query.${dcql.reason}`);
  if (params.client_metadata !== undefined && !isObject(params.client_metadata)) return refuse("invalid", "client_metadata");
  return {
    ok: true,
    value: {
      signed, verifier, origin, nonce, dcql: dcql.value, responseMode: mode as X401ResponseMode,
      ...(params.client_metadata !== undefined ? { clientMetadata: params.client_metadata as JsonObject } : {}),
      ...(typeof params.exp === "number" ? { expiresAt: params.exp } : {}),
    },
  };
}

async function readSigned(jar: unknown, url: URL, context: X401RequestContext, now: number): Promise<X401RequestReading> {
  if (typeof jar !== "string") return refuse("invalid", "data.request");
  const parts = jar.split(".");
  if (parts.length !== 3) return refuse("invalid", "data.request");
  let header: unknown, payload: unknown;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return refuse("invalid", "data.request"); }
  if (!isObject(header) || !isObject(payload)) return refuse("invalid", "data.request");
  if (header.alg !== "ES256") return refuse("unsupported", `alg ${String(header.alg)}`);
  if (header.typ !== undefined && header.typ !== "oauth-authz-req+jwt") return refuse("invalid", "typ");
  if (header.crit !== undefined) return refuse("unsupported", "crit");

  // The binding first: a request for another host is refused before its certificate or signature is looked at.
  const clientId = payload.client_id;
  if (typeof clientId !== "string" || !clientId) return refuse("invalid", "client_id");
  const prefix = "x509_san_dns:";
  if (!clientId.startsWith(prefix)) return refuse("unsupported", `client_id prefix ${clientId.split(":")[0]}`);
  if (clientId.slice(prefix.length).toLowerCase() !== url.hostname) return refuse("host", `client_id names ${clientId.slice(prefix.length)}`);
  const expected = payload.expected_origins;
  if (expected !== undefined) {
    if (!Array.isArray(expected) || expected.length === 0 || expected.length > X401_REQUEST_LIMITS.expectedOrigins ||
      !expected.every((o) => typeof o === "string")) return refuse("invalid", "expected_origins");
    if (!expected.includes(url.origin)) return refuse("host", `expected_origins does not list ${url.origin}`);
  }
  if (payload.exp !== undefined && !Number.isSafeInteger(payload.exp)) return refuse("invalid", "exp");
  if (typeof payload.exp === "number" && payload.exp * 1000 <= now) return refuse("expired");

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || x5c.length > X401_REQUEST_LIMITS.chain) return refuse("invalid", "x5c");
  let chain: Uint8Array[];
  try {
    chain = x5c.map((c) => {
      if (typeof c !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(c)) throw new Error("not base64");
      return fromBase64(c);
    });
  } catch { return refuse("invalid", "x5c"); }
  const leaf = await context.certificates(chain, url.hostname, now);
  if (!leaf.ok) return refuse("certificate", leaf.reason);

  let signature: Uint8Array;
  try { signature = fromBase64Url(parts[2]); } catch { return refuse("signature"); }
  let valid: boolean;
  try {
    valid = signature.length === 64 && p256.verify(signature, utf8Encode(`${parts[0]}.${parts[1]}`), leaf.publicKey, { lowS: false });
  } catch { valid = false; }
  if (!valid) return refuse("signature");
  return readParameters(payload, url.origin, clientId, true);
}

/**
 * Reads one entry of `credential_requirements.digital.requests` for the URL the agent called, checking a signed one's
 * binding, certificate and signature. Only `https:` is answered; `http:` only to a loopback host, for a local verifier.
 */
export async function readX401OpenId4VpRequest(entry: X401DigitalRequest, context: X401RequestContext): Promise<X401RequestReading> {
  let url: URL;
  try { url = new URL(context.url); } catch { return refuse("host", "not a URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return refuse("host", `${url.protocol} is not https:`);
  const now = context.now ?? Date.now();
  if (entry.protocol === X401_PROTOCOLS.signed) return readSigned(entry.data.request, url, context, now);
  if (entry.protocol === X401_PROTOCOLS.unsigned) {
    // An unsigned request is bound to the origin called; a `client_id` in it names nobody (OpenID4VP 1.0, A.2).
    return readParameters({ ...entry.data, exp: undefined }, url.origin, `origin:${url.origin}`, false);
  }
  return refuse("unsupported", `protocol ${entry.protocol}`);
}

/** What the person approves: this verifier, these credentials, these claims, and the token endpoint when one is used. */
export interface X401ApprovalSubject {
  verifier: string;
  matches: Pick<X401DcqlMatch, "credential" | "claims">[];
  /** The token endpoint's origin, when the approval also covers a token exchange. */
  tokenEndpoint?: string;
}

const pathKey = (path: X401ClaimPath) => JSON.stringify(path);

/**
 * The approval digest (`--approve <digest>`): SHA-256, base64url, over the verifier, each credential with its claim
 * paths, and the token endpoint's origin. Order does not count: a request that asks the same thing in another order
 * keeps its digest; one more claim, another credential or another verifier changes it.
 */
export function x401ApprovalDigest(subject: X401ApprovalSubject): string {
  const byCredential = new Map<string, Set<string>>();
  for (const { credential, claims } of subject.matches) {
    const paths = byCredential.get(credential) ?? new Set<string>();
    for (const claim of claims) paths.add(pathKey(claim));
    byCredential.set(credential, paths);
  }
  const credentials = [...byCredential.keys()].sort().map((credential) => [credential, [...byCredential.get(credential)!].sort()]);
  const canonical = JSON.stringify(["x401-approval-v1", subject.verifier, credentials, subject.tokenEndpoint ?? null]);
  return toBase64Url(sha256(utf8Encode(canonical)));
}
