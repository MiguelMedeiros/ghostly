import { parseAtprotoVerificationKey, type AtprotoPublicKey, type CborValue } from "./atprotoRepo";
import type { IdentityStatement } from "./identityProofs";

/**
 * AT Protocol identity, the pure half (no network): handle and DID syntax, what a DID document says
 * (the signing key, the PDS, the handle it claims), and the Ghostly proof record. Specs:
 * https://atproto.com/specs/handle, https://atproto.com/specs/did, https://atproto.com/specs/record-key.
 */

/** The Ghostly proof record's collection (NSID under ghostly.tools). Lexicon: docs/lexicons/tools.ghostly.proof.json. */
export const ATPROTO_PROOF_COLLECTION = "tools.ghostly.proof";

/**
 * What the OAuth sign-in asks for. `atproto` is required by every server; the granular repo scope lets
 * Ghostly create and delete records of its own collection only: no posts, no DMs, no profile edits.
 * Servers that predate granular permissions only know `transition:generic` (full access to the account's
 * repository); Ghostly asks for it only when the person picks that option, after being told.
 */
export const ATPROTO_PROOF_SCOPE = `atproto repo:${ATPROTO_PROOF_COLLECTION}?action=create&action=delete`;
export const ATPROTO_FULL_SCOPE = "atproto transition:generic";
/** Every scope the client metadata declares (a request may only use declared scopes). */
export const ATPROTO_DECLARED_SCOPE = `atproto repo:${ATPROTO_PROOF_COLLECTION}?action=create&action=delete transition:generic`;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HANDLE = new RegExp(`^(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`);
/** TLDs the handle spec disallows. `.test` stays allowed: it is how local networks (and the e2e suite) name accounts. */
const DISALLOWED_TLDS = new Set(["alt", "arpa", "example", "internal", "invalid", "local", "localhost", "onion"]);

/** A handle as people type it ("@Alice.bsky.social", "alice.bsky.social") → canonical, or null. */
export function normalizeAtprotoHandle(input: string): string | null {
  const handle = input.trim().replace(/^@/, "").toLowerCase();
  if (handle.length > 253 || !HANDLE.test(handle)) return null;
  if (DISALLOWED_TLDS.has(handle.slice(handle.lastIndexOf(".") + 1))) return null;
  return handle;
}

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
/** did:web at hostname level only (atproto does not use paths or ports). */
const DID_WEB = new RegExp(`^did:web:(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`);

export type AtprotoDidMethod = "plc" | "web";
export function atprotoDidMethod(did: string): AtprotoDidMethod | null {
  if (DID_PLC.test(did)) return "plc";
  if (did.length <= 261 && DID_WEB.test(did)) return "web";
  return null;
}
export const isAtprotoDid = (did: string) => atprotoDidMethod(did) !== null;

/** "did:plc:ab12cd…wxyz": the method, the first six and the last four characters. */
export function shortAtprotoDid(did: string): string {
  const m = /^(did:[a-z]+:)(.*)$/.exec(did);
  if (!m || m[2].length <= 14) return did;
  return `${m[1]}${m[2].slice(0, 6)}…${m[2].slice(-4)}`;
}

/** The record key of a proof: its proof key (z-base-32, already a valid record key), so removal finds it. */
export function atprotoProofRkey(proofKey: string): string {
  if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(proofKey)) throw new Error("Invalid proof key");
  return proofKey;
}

export interface AtprotoDidDocument {
  did: string;
  /** The repository signing key (`#atproto`). */
  key: AtprotoPublicKey;
  /** The PDS (`#atproto_pds`), as an https origin. */
  pds: string;
  /** The handle the document claims (first valid `at://`), normalized. Not verified: resolve it back. */
  handle?: string;
}

const fragment = (id: unknown, did: string, name: string) => id === `#${name}` || id === `${did}#${name}`;

/** A DID document (JSON already parsed) for `did`, strictly enough for atproto. Throws a message people can read. */
export function parseAtprotoDidDocument(doc: unknown, did: string): AtprotoDidDocument {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("The account's DID document is malformed");
  const d = doc as Record<string, unknown>;
  if (d.id !== did) throw new Error("The DID document is for another account");
  const methods = Array.isArray(d.verificationMethod) ? d.verificationMethod : [];
  const method = methods.find(m => m && typeof m === "object" && fragment((m as Record<string, unknown>).id, did, "atproto")) as Record<string, unknown> | undefined;
  if (!method || typeof method.type !== "string" || typeof method.publicKeyMultibase !== "string") throw new Error("The account has no atproto signing key");
  let key: AtprotoPublicKey;
  try { key = parseAtprotoVerificationKey(method.type, method.publicKeyMultibase); } catch { throw new Error("The account's signing key is not supported"); }
  const services = Array.isArray(d.service) ? d.service : [];
  const service = services.find(s => s && typeof s === "object" && fragment((s as Record<string, unknown>).id, did, "atproto_pds")) as Record<string, unknown> | undefined;
  if (!service || service.type !== "AtprotoPersonalDataServer" || typeof service.serviceEndpoint !== "string") throw new Error("The account names no server (PDS)");
  let pds: URL;
  try { pds = new URL(service.serviceEndpoint); } catch { throw new Error("The account's server address is malformed"); }
  if (pds.protocol !== "https:" || pds.username || pds.password || pds.search || pds.hash || (pds.pathname !== "/" && pds.pathname !== "")) throw new Error("The account's server must be an https address");
  const aka = Array.isArray(d.alsoKnownAs) ? d.alsoKnownAs : [];
  let handle: string | undefined;
  for (const entry of aka) {
    if (typeof entry !== "string" || !entry.startsWith("at://")) continue;
    handle = normalizeAtprotoHandle(entry.slice(5)) ?? undefined;
    break;
  }
  return { did, key, pds: pds.origin, ...(handle ? { handle } : {}) };
}

/** The record Ghostly writes: the statement, exactly, and when. */
export function atprotoProofRecord(statement: IdentityStatement, createdAt: Date): { $type: string; statement: string; createdAt: string } {
  return { $type: ATPROTO_PROOF_COLLECTION, statement: statement.text, createdAt: createdAt.toISOString() };
}

/** Checks a record read from a repository against the statement it must carry. */
export function checkAtprotoProofRecord(value: { [key: string]: CborValue }, statement: IdentityStatement): void {
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "$type,createdAt,statement") throw new Error("The record is not a Ghostly proof");
  if (value.$type !== ATPROTO_PROOF_COLLECTION) throw new Error("The record is not a Ghostly proof");
  if (typeof value.createdAt !== "string" || value.createdAt.length > 64) throw new Error("The record is not a Ghostly proof");
  if (value.statement !== statement.text) throw new Error("The record carries another statement");
}
