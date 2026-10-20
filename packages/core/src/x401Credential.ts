import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, toBase64Url, utf8Encode } from "./bytes";

/*
 * x401 credentials (WISP 3xx): the issued credentials a profile keeps, and the holder keys they are bound to. 1.4
 * reads SD-JWT VC only (`dc+sd-jwt`): an issuer-signed JWT, then its disclosures, each line ended by `~`.
 *
 * Reading checks the shape, never the issuer's signature: that needs the issuer's key, fetched from its metadata, and
 * a credential read here is only shown and kept, never trusted by Ghostly.
 */

export const X401_CREDENTIAL_LIMITS = {
  /** One issued credential, in characters. */
  chars: 64 * 1024,
  disclosures: 256,
} as const;

/** A P-256 public key as a JWK: what an issuer binds a credential to (`cnf.jwk`). */
export interface X401HolderJwk { kty: "EC"; crv: "P-256"; x: string; y: string }

/** A claim's place in the credential, as a DCQL query names it: member names and array indexes from the top. */
export type X401ClaimPath = (string | number)[];

export interface X401SdJwtVc {
  format: "dc+sd-jwt";
  /** The issuer-signed JWT, as it came. */
  jwt: string;
  /** The disclosures, as they came, in their order. */
  disclosures: string[];
  /** `vct`: the credential's type. */
  type: string;
  /** `iss`: shown, never trusted. */
  issuer: string;
  holder: X401HolderJwk;
  issuedAt?: number;
  /** `nbf`: the credential is not valid before this second. */
  notBefore?: number;
  expiresAt?: number;
  /** The claims with every disclosure in its place, without the JWT's own members (`iss`, `cnf`, `_sd`...). */
  claims: Record<string, unknown>;
  /** The claims a presentation may leave out: one path per disclosure. */
  disclosable: X401ClaimPath[];
  /** The disclosure that reveals each of `disclosable`, at the same index. */
  disclosedBy: string[];
}

export type X401CredentialReading = { ok: true; value: X401SdJwtVc } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const B64URL = /^[A-Za-z0-9_-]+$/;
/** Members of the JWT that say how to read the credential, not what it says. */
const REGISTERED = new Set(["iss", "nbf", "exp", "iat", "cnf", "vct", "vct#integrity", "status", "_sd", "_sd_alg"]);

/**
 * Sets a member as JSON has it: `__proto__` (an own member after JSON.parse) stays a member. `out[key] = value` would
 * make it the object's prototype instead, hiding a claim from the person that every presentation still carries.
 */
const put = (out: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });

function json(part: string): unknown {
  if (!B64URL.test(part)) throw new Error("not base64url");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(part)));
}

/** A fresh holder key: its secret, kept sealed by the profile, and the public JWK an issuer binds to. */
export function newX401HolderKey(): { secret: Uint8Array; jwk: X401HolderJwk } {
  const secret = p256.utils.randomSecretKey();
  return { secret, jwk: x401HolderJwk(p256.getPublicKey(secret, false)) };
}

/** The JWK of an uncompressed P-256 public key. */
export function x401HolderJwk(publicKey: Uint8Array): X401HolderJwk {
  return { kty: "EC", crv: "P-256", x: toBase64Url(publicKey.slice(1, 33)), y: toBase64Url(publicKey.slice(33, 65)) };
}

export const sameX401HolderJwk = (a: X401HolderJwk, b: X401HolderJwk) => a.crv === b.crv && a.x === b.x && a.y === b.y;

function holderOf(cnf: unknown): X401HolderJwk | undefined {
  const jwk = isObject(cnf) ? cnf.jwk : undefined;
  if (!isObject(jwk) || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return undefined;
  try {
    const x = fromBase64Url(jwk.x), y = fromBase64Url(jwk.y);
    if (x.length !== 32 || y.length !== 32) return undefined;
    p256.Point.fromBytes(concatBytes(new Uint8Array([4]), x, y)).assertValidity();
  } catch { return undefined; }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * Reads an issued SD-JWT VC: `<issuer-signed JWT>~<disclosure>~…~`. Refused, with the reason: anything over 64 KiB,
 * a key binding JWT after the last `~` (that is a presentation, not what an issuer gives), a JWT that is not signed or
 * not typed `dc+sd-jwt` (or the older `vc+sd-jwt`), no `iss` or `vct`, a `cnf` that is no P-256 JWK, a digest other
 * than SHA-256, and a disclosure that is malformed, given twice, or named by no digest of the credential.
 */
export function readX401SdJwtVc(text: string): X401CredentialReading {
  const refuse = (reason: string): X401CredentialReading => ({ ok: false, reason });
  const value = text.trim();
  if (value.length > X401_CREDENTIAL_LIMITS.chars) return refuse(`over ${X401_CREDENTIAL_LIMITS.chars / 1024} KiB`);
  const parts = value.split("~");
  if (parts.length < 2) return refuse("not an SD-JWT: no ~ after the JWT");
  if (parts[parts.length - 1] !== "") return refuse("it ends with a key binding JWT: that is a presentation, not an issued credential");
  const [jwt, ...rest] = parts.slice(0, -1);
  if (rest.length > X401_CREDENTIAL_LIMITS.disclosures) return refuse(`more than ${X401_CREDENTIAL_LIMITS.disclosures} disclosures`);
  const sections = jwt.split(".");
  if (sections.length !== 3 || !sections[2]) return refuse("the issuer's part is not a signed JWT");
  let header: unknown, payload: unknown;
  try { header = json(sections[0]); payload = json(sections[1]); } catch { return refuse("the issuer's JWT is not base64url JSON"); }
  if (!isObject(header) || !isObject(payload)) return refuse("the issuer's JWT is not base64url JSON");
  if (typeof header.alg !== "string" || header.alg === "none") return refuse("the issuer's JWT names no signature algorithm");
  if (header.typ !== "dc+sd-jwt" && header.typ !== "vc+sd-jwt") return refuse("not an SD-JWT VC (typ is not dc+sd-jwt)");
  if (payload._sd_alg !== undefined && payload._sd_alg !== "sha-256") return refuse(`digest ${String(payload._sd_alg)} is not supported (sha-256 only)`);
  if (typeof payload.iss !== "string" || !payload.iss) return refuse("no iss");
  if (typeof payload.vct !== "string" || !payload.vct) return refuse("no vct");
  const holder = holderOf(payload.cnf);
  if (!holder) return refuse("cnf names no P-256 key (cnf.jwk)");
  for (const time of ["iat", "nbf", "exp"] as const) if (payload[time] !== undefined && !Number.isSafeInteger(payload[time])) return refuse(`${time} is not a time`);

  const byDigest = new Map<string, unknown[]>();
  const textOf = new Map<unknown[], string>();
  for (const disclosure of rest) {
    let entry: unknown;
    try { entry = json(disclosure); } catch { return refuse("a disclosure is not base64url JSON"); }
    const named = Array.isArray(entry) && entry.length === 3 && typeof entry[1] === "string";
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !(named || entry.length === 2)) return refuse("a disclosure is not [salt, name, value] or [salt, value]");
    if (named && (entry[1] === "_sd" || entry[1] === "...")) return refuse(`a disclosure names ${entry[1]}`);
    const digest = toBase64Url(sha256(utf8Encode(disclosure)));
    if (byDigest.has(digest)) return refuse("a disclosure is given twice");
    byDigest.set(digest, entry);
    textOf.set(entry, disclosure);
  }

  // Each disclosure goes where its digest is: an object's `_sd`, or an array's `{"...": digest}`. Digests no
  // disclosure answers are decoys, and stay hidden.
  const used = new Set<string>();
  const disclosable: { path: X401ClaimPath; by: string }[] = [];
  const disclose = (path: X401ClaimPath, entry: unknown[]) => disclosable.push({ path, by: textOf.get(entry)! });
  let problem: string | undefined;
  const take = (digest: unknown): unknown[] | undefined => {
    if (typeof digest !== "string") { problem ??= "a digest is not a string"; return undefined; }
    const entry = byDigest.get(digest);
    if (entry && used.has(digest)) problem ??= "a digest is named twice";
    if (entry) used.add(digest);
    return entry;
  };
  const resolve = (node: unknown, path: X401ClaimPath, depth: number): unknown => {
    if (depth > 32) { problem ??= "nested too deep"; return null; }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        if (isObject(item) && Object.keys(item).length === 1 && "..." in item) {
          const entry = take(item["..."]);
          if (entry?.length === 2) { disclose([...path, out.length], entry); out.push(resolve(entry[1], [...path, out.length], depth + 1)); }
          else if (entry) problem ??= "an array element's disclosure has a name";
        } else out.push(resolve(item, [...path, out.length], depth + 1));
      }
      return out;
    }
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) if (key !== "_sd" && key !== "_sd_alg") put(out, key, resolve(item, [...path, key], depth + 1));
    if (node._sd !== undefined && !Array.isArray(node._sd)) problem ??= "_sd is not a list";
    for (const digest of Array.isArray(node._sd) ? node._sd : []) {
      const entry = take(digest);
      if (!entry) continue;
      if (entry.length !== 3) { problem ??= "an object member's disclosure has no name"; continue; }
      const name = entry[1] as string;
      if (Object.prototype.hasOwnProperty.call(out, name)) { problem ??= `${name} is given twice`; continue; }
      disclose([...path, name], entry);
      put(out, name, resolve(entry[2], [...path, name], depth + 1));
    }
    return out;
  };
  const all = resolve(payload, [], 0) as Record<string, unknown>;
  if (problem) return refuse(problem);
  if (used.size !== byDigest.size) return refuse("a disclosure is named by no digest of the credential");
  const claims = Object.fromEntries(Object.entries(all).filter(([key]) => !REGISTERED.has(key)));
  const kept = disclosable.filter(({ path }) => typeof path[0] !== "string" || !REGISTERED.has(path[0]));
  return {
    ok: true,
    value: {
      format: "dc+sd-jwt", jwt, disclosures: rest, type: payload.vct, issuer: payload.iss, holder,
      ...(payload.iat !== undefined ? { issuedAt: payload.iat as number } : {}),
      ...(payload.nbf !== undefined ? { notBefore: payload.nbf as number } : {}),
      ...(payload.exp !== undefined ? { expiresAt: payload.exp as number } : {}),
      claims, disclosable: kept.map(({ path }) => path), disclosedBy: kept.map(({ by }) => by),
    },
  };
}
