import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";

/*
 * x401 payloads (WISP 3xx), pinned to x401 0.2.0 (https://x401.proof.com/spec/). Three HTTP headers carry them, each
 * value the base64url (no padding) of one UTF-8 JSON object:
 *
 * - `PROOF-REQUEST`, from the verifier: what it wants proven (OpenID4VP requests inside `credential_requirements`).
 * - `PROOF-RESPONSE`, from the agent on its retry: a Result Artifact, or an x401 Token Object.
 * - `PROOF-RESULT`, from the verifier when a proof failed: an error object.
 *
 * This module only reads and builds them. It checks no signature, matches no credential and makes no HTTP call. A
 * value it cannot read is refused with a reason, never repaired: any version other than 0.2.0, any scheme other than
 * `x401`, more than one header line, a value over 16 KiB, padded or non-canonical base64url, bytes that are not UTF-8,
 * and JSON that is not one object. Unknown members are kept as they came and ignored.
 */

export const X401_SCHEME = "x401";
export const X401_VERSION = "0.2.0";

export const X401_HEADERS = {
  request: "PROOF-REQUEST",
  response: "PROOF-RESPONSE",
  result: "PROOF-RESULT",
} as const;

export const X401_PROTOCOLS = {
  signed: "openid4vp-v1-signed",
  unsigned: "openid4vp-v1-unsigned",
} as const;
export type X401Protocol = typeof X401_PROTOCOLS[keyof typeof X401_PROTOCOLS];

export const X401_LIMITS = {
  /** One header value, in characters of base64url. */
  headerChars: 16 * 1024,
} as const;

type JsonObject = Record<string, unknown>;

/** One entry of `credential_requirements.digital.requests`: an OpenID4VP request as the Digital Credentials API has it. */
export interface X401DigitalRequest {
  protocol: string;
  /** Signed: `{ request: <JAR compact JWS> }`. Unsigned: the OpenID4VP parameters themselves. */
  data: JsonObject;
}

export interface X401OAuth {
  token_endpoint: string;
  audience?: string;
  resource?: string;
}

export interface X401Payment {
  required?: boolean;
  scheme_hint?: string;
  notes?: string;
}

/** The decoded `PROOF-REQUEST`. `credential_requirements` is the verifier's object as it came: an agent never changes it. */
export interface X401ProofRequest {
  scheme: typeof X401_SCHEME;
  version: typeof X401_VERSION;
  credential_requirements: { digital: { requests: X401DigitalRequest[] } } & JsonObject;
  oauth?: X401OAuth;
  request_id?: string;
  satisfied_requirements?: string[];
  /** Set only by a relaying intermediary. Read so it can be shown, never followed (WISP 3xx, Security). */
  return_uri?: string;
  payment?: X401Payment;
}

/** The `{ protocol, data }` a Digital Credentials API presentation gives. */
export interface X401CredentialResult {
  protocol: string;
  data: JsonObject;
}

/** A Result Artifact: exactly one of `credential_result` (inline) and `credential_result_uri`. */
export interface X401ResultArtifact {
  credential_result?: X401CredentialResult;
  credential_result_uri?: string;
  expires_at?: string;
  request_id?: string;
  agent_id?: string;
}

export interface X401TokenObject {
  scheme: typeof X401_SCHEME;
  version: typeof X401_VERSION;
  token_type: "Bearer";
  access_token: string;
}

export type X401ProofResponse = { kind: "artifact"; artifact: X401ResultArtifact } | { kind: "token"; token: X401TokenObject };

/** The decoded `PROOF-RESULT`. Its texts are the verifier's words: show them as such, never trust them. */
export interface X401ProofResult {
  scheme: typeof X401_SCHEME;
  version: typeof X401_VERSION;
  error: string;
  error_description?: string;
  error_uri?: string;
  request_id?: string;
}

export type X401Refusal =
  /** More than one header line, or several values joined with commas. */
  | "duplicate"
  | "too-large"
  | "bad-base64url"
  /** Not UTF-8, not JSON, or JSON that is not one object. */
  | "not-object"
  | "scheme"
  | "version"
  /** A member is missing or has the wrong shape; `detail` names it. */
  | "invalid"
  /** No request uses an OpenID4VP protocol x401 0.2.0 defines. */
  | "unsupported";

export type X401Reading<T> = { ok: true; value: T } | { ok: false; reason: X401Refusal; detail?: string };

/** What reads a header: a Fetch `Headers` joins repeated lines with ", ", which a base64url value never holds. */
export interface X401HeaderSource {
  get(name: string): string | null;
}

const refuse = (reason: X401Refusal, detail?: string): { ok: false; reason: X401Refusal; detail?: string } =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";

function isUrl(value: unknown): value is string {
  if (!isText(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}

/** A URL an agent may be sent to: `https:`, or `http:` to a loopback host for a local verifier (as the route called). */
function isAgentUrl(value: unknown): value is string {
  if (!isUrl(value)) return false;
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}

/** RFC 3339 date-time, as `expires_at` carries it. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const isTimestamp = (value: unknown): value is string => typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

/** A compact JWS: three base64url parts, the payload possibly empty. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

/** An `error` code: short printable ASCII, no spaces. */
const ERROR_CODE = /^[\x21-\x7e]{1,128}$/;

/** One header value as base64url of a UTF-8 JSON object. */
export function encodeX401Header(payload: object): string {
  return toBase64Url(utf8Encode(JSON.stringify(payload)));
}

/** Decodes one header value to its JSON object, refusing anything that is not exactly that. */
export function decodeX401Header(value: string): X401Reading<JsonObject> {
  if (value.length > X401_LIMITS.headerChars) return refuse("too-large", `${value.length} characters`);
  if (value.includes(",")) return refuse("duplicate");
  const text = value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return refuse("bad-base64url");
  let bytes: Uint8Array;
  try { bytes = fromBase64Url(text); } catch { return refuse("bad-base64url"); }
  if (toBase64Url(bytes) !== text) return refuse("bad-base64url");
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Strict.decode(bytes)); } catch { return refuse("not-object"); }
  if (!isObject(parsed)) return refuse("not-object");
  return { ok: true, value: parsed };
}

/** `scheme` and `version` of a payload, token or error object: x401 0.2.0 only. */
function checkSchemeVersion(payload: JsonObject): X401Reading<null> {
  if (payload.scheme !== X401_SCHEME) return refuse("scheme", typeof payload.scheme === "string" ? payload.scheme : undefined);
  if (payload.version !== X401_VERSION) return refuse("version", typeof payload.version === "string" ? payload.version : undefined);
  return { ok: true, value: null };
}

function readDigitalRequest(entry: unknown, index: number): X401Reading<X401DigitalRequest> {
  const at = `credential_requirements.digital.requests[${index}]`;
  if (!isObject(entry) || !isText(entry.protocol) || !isObject(entry.data)) return refuse("invalid", at);
  if (entry.protocol === X401_PROTOCOLS.signed && !(typeof entry.data.request === "string" && COMPACT_JWS.test(entry.data.request))) {
    return refuse("invalid", `${at}.data.request`);
  }
  return { ok: true, value: entry as unknown as X401DigitalRequest };
}

/** Reads a decoded `PROOF-REQUEST` payload. */
export function readX401ProofRequest(payload: JsonObject): X401Reading<X401ProofRequest> {
  const head = checkSchemeVersion(payload);
  if (!head.ok) return head;
  const requirements = payload.credential_requirements;
  if (!isObject(requirements) || !isObject(requirements.digital)) return refuse("invalid", "credential_requirements.digital");
  const requests = requirements.digital.requests;
  if (!Array.isArray(requests) || requests.length === 0) return refuse("invalid", "credential_requirements.digital.requests");
  for (let i = 0; i < requests.length; i++) {
    const read = readDigitalRequest(requests[i], i);
    if (!read.ok) return read;
  }
  if (!requests.some((r: X401DigitalRequest) => isX401Protocol(r.protocol))) return refuse("unsupported");
  const { oauth, payment } = payload;
  if (oauth !== undefined) {
    if (!isObject(oauth) || !isAgentUrl(oauth.token_endpoint)) return refuse("invalid", "oauth.token_endpoint");
    if (!optionalText(oauth.audience)) return refuse("invalid", "oauth.audience");
    if (!optionalText(oauth.resource)) return refuse("invalid", "oauth.resource");
  }
  if (!optionalText(payload.request_id)) return refuse("invalid", "request_id");
  const satisfied = payload.satisfied_requirements;
  if (satisfied !== undefined && !(Array.isArray(satisfied) && satisfied.every((s) => typeof s === "string"))) {
    return refuse("invalid", "satisfied_requirements");
  }
  if (payload.return_uri !== undefined && !isUrl(payload.return_uri)) return refuse("invalid", "return_uri");
  if (payment !== undefined) {
    if (!isObject(payment)) return refuse("invalid", "payment");
    if (payment.required !== undefined && typeof payment.required !== "boolean") return refuse("invalid", "payment.required");
    if (!optionalText(payment.scheme_hint)) return refuse("invalid", "payment.scheme_hint");
    if (!optionalText(payment.notes)) return refuse("invalid", "payment.notes");
  }
  return { ok: true, value: payload as unknown as X401ProofRequest };
}

export const isX401Protocol = (protocol: string): protocol is X401Protocol =>
  protocol === X401_PROTOCOLS.signed || protocol === X401_PROTOCOLS.unsigned;

/**
 * The requests an agent may answer, in the order it should try them: signed ones first (WISP 3xx, step 3), then
 * unsigned, each in the verifier's order. Entries with another protocol are left out.
 */
export function x401AnswerableRequests(request: X401ProofRequest): X401DigitalRequest[] {
  const requests = request.credential_requirements.digital.requests;
  return [
    ...requests.filter((r) => r.protocol === X401_PROTOCOLS.signed),
    ...requests.filter((r) => r.protocol === X401_PROTOCOLS.unsigned),
  ];
}

/** Reads a decoded `PROOF-RESPONSE`: a Token Object when it has a `token_type`, else a Result Artifact. */
export function readX401ProofResponse(payload: JsonObject): X401Reading<X401ProofResponse> {
  if (payload.token_type !== undefined || payload.access_token !== undefined) {
    const head = checkSchemeVersion(payload);
    if (!head.ok) return head;
    if (payload.token_type !== "Bearer") return refuse("invalid", "token_type");
    if (!isText(payload.access_token)) return refuse("invalid", "access_token");
    return { ok: true, value: { kind: "token", token: payload as unknown as X401TokenObject } };
  }
  const inline = payload.credential_result, uri = payload.credential_result_uri;
  if ((inline === undefined) === (uri === undefined)) return refuse("invalid", "credential_result");
  if (inline !== undefined && !(isObject(inline) && isText(inline.protocol) && isObject(inline.data))) return refuse("invalid", "credential_result");
  if (uri !== undefined && !(isUrl(uri) && new URL(uri).protocol === "https:")) return refuse("invalid", "credential_result_uri");
  if (payload.expires_at !== undefined && !isTimestamp(payload.expires_at)) return refuse("invalid", "expires_at");
  if (!optionalText(payload.request_id)) return refuse("invalid", "request_id");
  if (!optionalText(payload.agent_id)) return refuse("invalid", "agent_id");
  return { ok: true, value: { kind: "artifact", artifact: payload as unknown as X401ResultArtifact } };
}

/** Reads a decoded `PROOF-RESULT`. */
export function readX401ProofResult(payload: JsonObject): X401Reading<X401ProofResult> {
  const head = checkSchemeVersion(payload);
  if (!head.ok) return head;
  if (typeof payload.error !== "string" || !ERROR_CODE.test(payload.error)) return refuse("invalid", "error");
  if (!optionalText(payload.error_description)) return refuse("invalid", "error_description");
  if (payload.error_uri !== undefined && !(isUrl(payload.error_uri) && new URL(payload.error_uri).protocol === "https:")) {
    return refuse("invalid", "error_uri");
  }
  if (!optionalText(payload.request_id)) return refuse("invalid", "request_id");
  return { ok: true, value: payload as unknown as X401ProofResult };
}

function readHeader<T>(headers: X401HeaderSource, name: string, read: (payload: JsonObject) => X401Reading<T>): X401Reading<T> | null {
  const value = headers.get(name);
  if (value === null) return null;
  const decoded = decodeX401Header(value);
  return decoded.ok ? read(decoded.value) : decoded;
}

/** The `PROOF-REQUEST` of a response, `null` when it has none. */
export const readX401ProofRequestHeader = (headers: X401HeaderSource): X401Reading<X401ProofRequest> | null =>
  readHeader(headers, X401_HEADERS.request, readX401ProofRequest);

/** The `PROOF-RESPONSE` of a request, `null` when it has none. */
export const readX401ProofResponseHeader = (headers: X401HeaderSource): X401Reading<X401ProofResponse> | null =>
  readHeader(headers, X401_HEADERS.response, readX401ProofResponse);

/** The `PROOF-RESULT` of a response, `null` when it has none. */
export const readX401ProofResultHeader = (headers: X401HeaderSource): X401Reading<X401ProofResult> | null =>
  readHeader(headers, X401_HEADERS.result, readX401ProofResult);

/** A `PROOF-RESPONSE` value carrying an inline Result Artifact (an agent never sends `credential_result_uri`). */
export function buildX401ResultArtifact(result: X401CredentialResult, extra: { expires_at?: string; request_id?: string; agent_id?: string } = {}): string {
  return encodeX401Header({ credential_result: result, ...extra });
}

/** A `PROOF-RESPONSE` value carrying a Verification Token. */
export function buildX401TokenObject(accessToken: string): string {
  const token: X401TokenObject = { scheme: X401_SCHEME, version: X401_VERSION, token_type: "Bearer", access_token: accessToken };
  return encodeX401Header(token);
}

/** A `PROOF-REQUEST` value, for a verifier (the local one of the CLI's tests). */
export function buildX401ProofRequest(fields: Omit<X401ProofRequest, "scheme" | "version">): string {
  return encodeX401Header({ scheme: X401_SCHEME, version: X401_VERSION, ...fields });
}

/** A `PROOF-RESULT` value, for a verifier (the local one of the CLI's tests). */
export function buildX401ProofResult(fields: Omit<X401ProofResult, "scheme" | "version">): string {
  return encodeX401Header({ scheme: X401_SCHEME, version: X401_VERSION, ...fields });
}
