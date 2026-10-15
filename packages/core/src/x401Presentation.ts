import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "./bytes";
import type { X401ClaimPath, X401SdJwtVc } from "./x401Credential";

/*
 * x401 presentations (WISP 3xx, Answering a proof request, steps 4 and 6): the DCQL query of an OpenID4VP request
 * (OpenID4VP 1.0 §6) matched against the credentials a profile keeps, and the SD-JWT VC presentation that answers it.
 *
 * Matching reads only what the profile holds: it fetches nothing, trusts no issuer and asks no one. Which verifier is
 * asking, and whether the person approved, are the caller's. A presentation carries the issuer's JWT, the disclosures
 * of the claims approved (and of the members they sit in) and nothing more, then a Key Binding JWT for that verifier.
 */

/** A claim path as a query writes it: member names, array indexes, and `null` for every element of an array. */
export type X401DcqlPath = (string | number | null)[];

export interface X401DcqlClaim { id?: string; path: X401DcqlPath; values?: (string | number | boolean)[] }

export interface X401DcqlCredentialQuery {
  id: string;
  format: string;
  multiple?: boolean;
  meta?: { vct_values?: string[] } & Record<string, unknown>;
  claims?: X401DcqlClaim[];
  claim_sets?: string[][];
  /** The issuers the verifier trusts: shown to the person as its hint, never used to decide. */
  trusted_authorities?: unknown[];
}

export interface X401DcqlCredentialSet { options: string[][]; required?: boolean }

export interface X401DcqlQuery { credentials: X401DcqlCredentialQuery[]; credential_sets?: X401DcqlCredentialSet[] }

export const X401_DCQL_LIMITS = { credentials: 32, claims: 64, pathDepth: 32, values: 64, sets: 32 } as const;

/** A credential the profile keeps, as matching sees it. */
export interface X401HeldCredential { id: string; vc: X401SdJwtVc }

/** One credential query answered: by which credential, disclosing which claims (concrete paths, no `null`). */
export interface X401DcqlMatch { query: string; credential: string; claims: X401ClaimPath[] }

/** What a credential query asked, to show when nothing the profile keeps answers it. */
export interface X401DcqlAsk { query: string; format: string; types: string[]; claims: X401DcqlPath[] }

export type X401DcqlOutcome = { ok: true; matches: X401DcqlMatch[] } | { ok: false; asked: X401DcqlAsk[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** DCQL ids: alphanumerics, `_` and `-`. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isId);

function pathProblem(path: unknown): boolean {
  return !Array.isArray(path) || path.length === 0 || path.length > X401_DCQL_LIMITS.pathDepth ||
    !path.every((step) => step === null || typeof step === "string" || (Number.isSafeInteger(step) && (step as number) >= 0));
}

function readCredentialQuery(entry: unknown, at: string): string | null {
  if (!isObject(entry)) return at;
  if (!isId(entry.id)) return `${at}.id`;
  if (typeof entry.format !== "string" || !entry.format) return `${at}.format`;
  if (entry.multiple !== undefined && typeof entry.multiple !== "boolean") return `${at}.multiple`;
  if (entry.meta !== undefined) {
    if (!isObject(entry.meta)) return `${at}.meta`;
    const types = entry.meta.vct_values;
    if (types !== undefined && !(Array.isArray(types) && types.every((t) => typeof t === "string"))) return `${at}.meta.vct_values`;
  }
  if (entry.trusted_authorities !== undefined && !Array.isArray(entry.trusted_authorities)) return `${at}.trusted_authorities`;
  const claims = entry.claims;
  const ids = new Set<string>();
  if (claims !== undefined) {
    if (!Array.isArray(claims) || claims.length === 0 || claims.length > X401_DCQL_LIMITS.claims) return `${at}.claims`;
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i], here = `${at}.claims[${i}]`;
      if (!isObject(claim)) return here;
      if (claim.id !== undefined) {
        if (!isId(claim.id)) return `${here}.id`;
        if (ids.has(claim.id)) return `${here}.id is given twice`;
        ids.add(claim.id);
      }
      if (pathProblem(claim.path)) return `${here}.path`;
      const values = claim.values;
      if (values !== undefined && !(Array.isArray(values) && values.length > 0 && values.length <= X401_DCQL_LIMITS.values &&
        values.every((v) => typeof v === "string" || typeof v === "boolean" || Number.isFinite(v)))) return `${here}.values`;
    }
  }
  const sets = entry.claim_sets;
  if (sets !== undefined) {
    if (claims === undefined || !Array.isArray(sets) || sets.length === 0 || sets.length > X401_DCQL_LIMITS.sets ||
      !sets.every((set) => isIdList(set) && set.every((id) => ids.has(id)))) return `${at}.claim_sets`;
  }
  return null;
}

/** Reads `dcql_query`. Refused with the member at fault: a query Ghostly cannot answer exactly as written. */
export function readX401DcqlQuery(value: unknown): { ok: true; value: X401DcqlQuery } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!isObject(value)) return refuse("credentials");
  const credentials = value.credentials;
  if (!Array.isArray(credentials) || credentials.length === 0 || credentials.length > X401_DCQL_LIMITS.credentials) return refuse("credentials");
  const ids = new Set<string>();
  for (let i = 0; i < credentials.length; i++) {
    const problem = readCredentialQuery(credentials[i], `credentials[${i}]`);
    if (problem) return refuse(problem);
    const id = (credentials[i] as X401DcqlCredentialQuery).id;
    if (ids.has(id)) return refuse(`credentials[${i}].id is given twice`);
    ids.add(id);
  }
  const sets = value.credential_sets;
  if (sets !== undefined) {
    if (!Array.isArray(sets) || sets.length === 0 || sets.length > X401_DCQL_LIMITS.sets) return refuse("credential_sets");
    for (const set of sets) {
      if (!isObject(set) || !Array.isArray(set.options) || set.options.length === 0 ||
        !set.options.every((option) => isIdList(option) && option.every((id) => ids.has(id)))) return refuse("credential_sets");
      if (set.required !== undefined && typeof set.required !== "boolean") return refuse("credential_sets");
    }
  }
  return { ok: true, value: value as unknown as X401DcqlQuery };
}

/** Every concrete path `path` names in `node`, with the value there. */
function select(node: unknown, path: X401DcqlPath, at: X401ClaimPath = []): { path: X401ClaimPath; value: unknown }[] {
  if (path.length === 0) return [{ path: at, value: node }];
  const [step, ...rest] = path;
  if (step === null) return Array.isArray(node) ? node.flatMap((item, i) => select(item, rest, [...at, i])) : [];
  if (typeof step === "number") return Array.isArray(node) && step < node.length ? select(node[step], rest, [...at, step]) : [];
  return isObject(node) && Object.prototype.hasOwnProperty.call(node, step) ? select(node[step], rest, [...at, step]) : [];
}

/** The concrete paths of one claim, `null` when the credential does not hold it (with one of its `values`, if any). */
function claimPaths(vc: X401SdJwtVc, claim: X401DcqlClaim): X401ClaimPath[] | null {
  const found = select(vc.claims, claim.path).filter(({ value }) => !claim.values || claim.values.some((v) => v === value));
  return found.length ? found.map(({ path }) => path) : null;
}

/** The claims a credential discloses for a query, `null` when it cannot answer it. Claim sets in the verifier's order. */
function answer(vc: X401SdJwtVc, query: X401DcqlCredentialQuery): X401ClaimPath[] | null {
  const claims = query.claims ?? [];
  const options = query.claim_sets ? query.claim_sets.map((set) => claims.filter((c) => c.id !== undefined && set.includes(c.id))) : [claims];
  for (const option of options) {
    const paths: X401ClaimPath[] = [];
    if (option.every((claim) => { const found = claimPaths(vc, claim); if (found) paths.push(...found); return found !== null; })) return paths;
  }
  return null;
}

function matchOne(query: X401DcqlCredentialQuery, held: X401HeldCredential[], now: number): X401DcqlMatch | null {
  const types = query.meta?.vct_values;
  for (const { id, vc } of held) {
    if (query.format !== vc.format || (types && !types.includes(vc.type))) continue;
    if (vc.expiresAt !== undefined && vc.expiresAt * 1000 <= now) continue;
    const claims = answer(vc, query);
    if (claims) return { query: query.id, credential: id, claims };
  }
  return null;
}

/**
 * Matches a DCQL query against the credentials held, in their order: the first one of the asked format and type, not
 * expired, that holds every claim asked. With credential sets, each required set takes its first option the profile
 * can answer whole, and optional sets are left out (least disclosure); without them, every credential query must be
 * answered. One credential per query, even when the query allows `multiple`.
 */
export function matchX401Dcql(query: X401DcqlQuery, held: X401HeldCredential[], now = Date.now()): X401DcqlOutcome {
  const matched = new Map<string, X401DcqlMatch | null>(query.credentials.map((q) => [q.id, matchOne(q, held, now)]));
  const asked = (): X401DcqlOutcome => ({
    ok: false,
    asked: query.credentials.map((q) => ({ query: q.id, format: q.format, types: q.meta?.vct_values ?? [], claims: (q.claims ?? []).map((c) => c.path) })),
  });
  let wanted: string[];
  if (!query.credential_sets) wanted = query.credentials.map((q) => q.id);
  else {
    wanted = [];
    for (const set of query.credential_sets.filter((s) => s.required !== false)) {
      const option = set.options.find((ids) => ids.every((id) => matched.get(id)));
      if (!option) return asked();
      wanted.push(...option.filter((id) => !wanted.includes(id)));
    }
  }
  const matches = wanted.map((id) => matched.get(id));
  return matches.every((m): m is X401DcqlMatch => !!m) ? { ok: true, matches } : asked();
}

const startsWith = (path: X401ClaimPath, prefix: X401ClaimPath) => prefix.length <= path.length && prefix.every((step, i) => path[i] === step);

/** What ties a presentation to one verifier and one request (the Key Binding JWT's members). */
export interface X401Binding { holderSecret: Uint8Array; aud: string; nonce: string; iat?: number }

/**
 * An SD-JWT VC presentation: the issuer's JWT, the disclosures of the claims given (each claim's own, those of the
 * members it sits in, and those inside it), then a Key Binding JWT signed by the holder key with `aud`, `nonce`,
 * `iat` and `sd_hash` over everything before it.
 */
export function presentX401SdJwtVc(vc: X401SdJwtVc, claims: X401ClaimPath[], binding: X401Binding): string {
  const disclosures = vc.disclosedBy.filter((_, i) => claims.some((claim) => startsWith(claim, vc.disclosable[i]) || startsWith(vc.disclosable[i], claim)));
  const presented = `${[vc.jwt, ...disclosures].join("~")}~`;
  const json = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));
  const head = json({ alg: "ES256", typ: "kb+jwt" });
  const body = json({
    iat: binding.iat ?? Math.floor(Date.now() / 1000), aud: binding.aud, nonce: binding.nonce,
    sd_hash: toBase64Url(sha256(utf8Encode(presented))),
  });
  const signature = toBase64Url(p256.sign(utf8Encode(`${head}.${body}`), binding.holderSecret));
  return `${presented}${head}.${body}.${signature}`;
}

/**
 * The `vp_token` of an OpenID4VP response: each presentation in a list under its credential query id. The ids are the
 * verifier's, and `constructor` or `__proto__` is one as good as `pid`: gathered in a Map, answered as own members.
 */
export function x401VpToken(presentations: { query: string; presentation: string }[]): Record<string, string[]> {
  const token = new Map<string, string[]>();
  for (const { query, presentation } of presentations) {
    const list = token.get(query);
    if (list) list.push(presentation);
    else token.set(query, [presentation]);
  }
  return Object.fromEntries(token);
}
