import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { bytesEqual, concatBytes, fromZ32, toBase64Url, toZ32, utf8Decode, utf8Encode } from "./bytes";
import { normalizeDomain } from "./domainProofs";

/**
 * Decentralized identifiers (W3C DID Core 1.0) as external identities, network-free half: DID syntax,
 * the documents did:key and did:jwk carry in the identifier itself, did:web's URLs, strict parsing of a
 * fetched DID document, and JWS / raw signatures by the keys it lists. Fetching did:web documents and
 * did:dht records is the browser's (`packages/browser/src/proofs/did.ts`).
 *
 * Only keys a document lists under `authentication` or `assertionMethod` may sign for the DID: a key
 * listed only for key agreement or capability delegation does not speak for it.
 */

export class DidError extends Error {}

export const DID_METHODS = ["key", "jwk", "dht", "web"] as const;
export type DidMethod = (typeof DID_METHODS)[number];
export type DidCurve = "Ed25519" | "secp256k1" | "P-256";
export type DidRelationship = "authentication" | "assertionMethod";
const RELATIONSHIPS: readonly DidRelationship[] = ["authentication", "assertionMethod"];

/** Same bound as an identity proof's subject (printable ASCII, no spaces). */
export const DID_MAX_LENGTH = 512;
/** A fetched did.json. */
export const DID_DOCUMENT_MAX_BYTES = 64 * 1024;
/** The statement file a did:web publishes beside its did.json. */
export const DID_FILE_MAX_BYTES = 16 * 1024;
export const DID_JWS_MAX_LENGTH = 4096;
/** Entries read from each list of a document; the rest are ignored. */
const MAX_ENTRIES = 64;
/** The service type a did.json uses to vouch for a Ghostly proof. */
export const DID_GHOSTLY_SERVICE = "GhostlyIdentityProof";

export interface DidKey {
  /** The verification method's absolute id: `<did>#<fragment>`. */
  id: string;
  curve: DidCurve;
  /** Ed25519: 32 bytes. secp256k1 and P-256: 33 bytes, compressed. */
  publicKey: Uint8Array;
  /** Empty when the document lists the key but not for authentication or assertionMethod. */
  relationships: DidRelationship[];
}

/** A `GhostlyIdentityProof` service: the document names a proof key and the statement id it vouches for. */
export interface DidGhostlyService { id: string; key: string; proof: string }

/** What a DID document says, as far as Ghostly uses it. */
export interface DidDocumentView {
  did: string;
  keys: DidKey[];
  /** Verification methods Ghostly cannot use (other curves, key agreement keys, other DIDs' ids). */
  skipped: number;
  services: DidGhostlyService[];
}

const METHOD_NAME = /^[a-z0-9]+$/;
const Z32_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const METHOD_LIST = "did:key, did:jwk, did:dht and did:web";

/** base64url without padding, strictly: decoding and encoding again gives the same text. */
export function strictBase64Url(value: string): Uint8Array {
  if (typeof value !== "string" || !B64URL.test(value) || value.length % 4 === 1) throw new DidError("Not base64url");
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad), c => c.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new DidError("Not canonical base64url");
  return bytes;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Syntax

export interface ParsedDid { did: string; method: DidMethod; id: string }

/**
 * The DID a person typed, checked and in canonical form, or a message they can act on. Methods other than
 * the four Ghostly checks are refused with "not supported yet"; a DID URL (a `#fragment`, `?query` or
 * `/path`) is refused, since it names something inside a DID rather than the DID.
 */
export function parseDid(input: string): ParsedDid {
  if (typeof input !== "string") throw new DidError("Enter a DID, like did:key:z6Mk… or did:web:example.com");
  const value = input.trim();
  if (!/^did:/i.test(value)) throw new DidError("Enter a DID, like did:key:z6Mk… or did:web:example.com");
  if (value.length > DID_MAX_LENGTH) throw new DidError(`That DID is too long (at most ${DID_MAX_LENGTH} characters)`);
  if (/[#?/]/.test(value)) throw new DidError("Enter the DID alone, without a #fragment, ?query or /path");
  const rest = value.slice(4);
  const colon = rest.indexOf(":");
  const method = colon > 0 ? rest.slice(0, colon) : "";
  const id = colon > 0 ? rest.slice(colon + 1) : "";
  if (!METHOD_NAME.test(method.toLowerCase()) || !id) throw new DidError("That is not a DID: it looks like did:<method>:<identifier>");
  if (method !== method.toLowerCase() && DID_METHODS.includes(method.toLowerCase() as DidMethod)) throw new DidError(`Write the method in lowercase: did:${method.toLowerCase()}:…`);
  if (!DID_METHODS.includes(method as DidMethod)) throw new DidError(`did:${method} is not supported yet. Ghostly checks ${METHOD_LIST}.`);
  if (!/^[\x21-\x7e]+$/.test(id)) throw new DidError("A DID has no spaces or other special characters");
  switch (method as DidMethod) {
    case "key": staticKey(`did:key:${id}`); return { did: `did:key:${id}`, method: "key", id };
    case "jwk": staticKey(`did:jwk:${id}`); return { did: `did:jwk:${id}`, method: "jwk", id };
    case "dht": {
      const key = id.toLowerCase();
      if (!Z32_KEY.test(key) || toZ32(fromZ32(key)) !== key) throw new DidError("A did:dht identifier is 52 z-base-32 characters");
      return { did: `did:dht:${key}`, method: "dht", id: key };
    }
    case "web": {
      const web = parseWeb(id);
      return { did: `did:web:${web.id}`, method: "web", id: web.id };
    }
  }
}

/** The canonical form of a DID Ghostly checks (a lowercase did:web host, a lowercase did:dht key). */
export const normalizeDid = (input: string) => parseDid(input).did;

// ---------------------------------------------------------------------------------------------
// did:web

interface WebDid { id: string; host: string; port?: number; path: string[] }

function parseWeb(id: string): WebDid {
  const [hostPart, ...path] = id.split(":");
  const portMatch = /^(.*)%3a(\d{1,5})$/i.exec(hostPart);
  const hostInput = portMatch ? portMatch[1] : hostPart;
  if (/%/.test(hostInput)) throw new DidError("A did:web domain has no percent-encoding, other than %3A before a port");
  let host: string;
  try { host = normalizeDomain(hostInput); } catch (e) { throw new DidError(`did:web: ${(e as Error).message}`); }
  if (hostInput.toLowerCase().replace(/\.$/, "") !== host) throw new DidError("did:web: write the domain as ASCII (punycode for international names)");
  let port: number | undefined;
  if (portMatch) {
    port = Number(portMatch[2]);
    if (!(port >= 1 && port <= 65535) || String(port) !== portMatch[2]) throw new DidError("did:web: that port is not valid");
  }
  if (path.length > 8) throw new DidError("did:web: at most 8 path segments");
  for (const segment of path) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") throw new DidError("did:web: each path segment is letters, digits, dots, dashes, underscores or tildes");
  }
  return { id: [`${host}${port ? `%3A${port}` : ""}`, ...path].join(":"), host, port, path };
}

const web = (did: string): WebDid => {
  const parsed = parseDid(did);
  if (parsed.method !== "web") throw new DidError("Not a did:web");
  return parseWeb(parsed.id);
};

/** The host a did:web lives on (no port): the name looked up before contacting it. */
export const didWebHost = (did: string) => web(did).host;
const origin = (w: WebDid) => `https://${w.host}${w.port ? `:${w.port}` : ""}`;
/** did:web → its did.json: `/.well-known/did.json` for a bare domain, `/<path>/did.json` otherwise. */
export function didWebDocumentUrl(did: string): string {
  const w = web(did);
  return `${origin(w)}/${w.path.length ? w.path.join("/") : ".well-known"}/did.json`;
}
/** Where a did:web publishes the statement of proof `proofId`: `ghostly/<id>.json` beside its did.json. */
export function didWebFileUrl(did: string, proofId: string): string {
  if (!HEX64.test(proofId)) throw new DidError("Invalid proof id");
  const w = web(did);
  return `${origin(w)}/${w.path.length ? w.path.join("/") : ".well-known"}/ghostly/${proofId}.json`;
}

/** The body of that file: the DID and the exact statement text. */
export function didWebFile(did: string, statement: string): string {
  return JSON.stringify({ ghostly: 1, did, statement }, null, 2) + "\n";
}
/** True when `text` is a statement file for exactly this DID and statement. */
export function didWebFileNames(text: string, did: string, statement: string): boolean {
  if (typeof text !== "string" || utf8Encode(text).length > DID_FILE_MAX_BYTES) return false;
  let body: unknown;
  try { body = JSON.parse(text); } catch { return false; }
  return isObject(body) && body.ghostly === 1 && body.did === did && body.statement === statement;
}

/** The service entry a did.json can carry instead of the file. */
export function didGhostlyServiceEntry(did: string, key: string, proofId: string): Record<string, unknown> {
  return { id: `${did}#ghostly-${proofId.slice(0, 12)}`, type: DID_GHOSTLY_SERVICE, serviceEndpoint: { key, proof: proofId } };
}

// ---------------------------------------------------------------------------------------------
// Keys

/** Multicodec prefixes (unsigned varint) of the public keys Ghostly checks, and X25519 to name it when refused. */
const MULTICODEC: { prefix: [number, number]; curve: DidCurve | "X25519"; length: number }[] = [
  { prefix: [0xed, 0x01], curve: "Ed25519", length: 32 },
  { prefix: [0xe7, 0x01], curve: "secp256k1", length: 33 },
  { prefix: [0x80, 0x24], curve: "P-256", length: 33 },
  { prefix: [0xec, 0x01], curve: "X25519", length: 32 },
];

/** A public key on its curve, validated; ECDSA keys compressed. */
function curveKey(curve: DidCurve, bytes: Uint8Array): Uint8Array {
  try {
    if (curve === "Ed25519") { if (bytes.length !== 32) throw new Error(); ed25519.Point.fromBytes(bytes); return bytes; }
    const point = (curve === "secp256k1" ? secp256k1 : p256).Point.fromBytes(bytes);
    return point.toBytes(true);
  } catch { throw new DidError(`That ${curve} key is not a valid point`); }
}

/** A `z…` multibase (base58btc) multicodec key. X25519 and unknown codecs are `undefined`. */
function multikey(value: string): { curve: DidCurve; publicKey: Uint8Array } | { curve: "X25519" } | undefined {
  if (typeof value !== "string" || !value.startsWith("z") || value.length > 128) return undefined;
  let bytes: Uint8Array;
  try { bytes = base58.decode(value.slice(1)); } catch { return undefined; }
  const codec = MULTICODEC.find(c => bytes[0] === c.prefix[0] && bytes[1] === c.prefix[1]);
  if (!codec || bytes.length !== codec.length + 2) return undefined;
  if (codec.curve === "X25519") return { curve: "X25519" };
  return { curve: codec.curve, publicKey: curveKey(codec.curve, bytes.subarray(2)) };
}

const JWK_CURVES: Record<string, { kty: string; curve: DidCurve }> = {
  Ed25519: { kty: "OKP", curve: "Ed25519" },
  secp256k1: { kty: "EC", curve: "secp256k1" },
  "P-256": { kty: "EC", curve: "P-256" },
};

/** A public JWK. Other curves are `undefined`; a malformed one throws. */
function jwkKey(jwk: unknown): { curve: DidCurve; publicKey: Uint8Array } | undefined {
  if (!isObject(jwk)) throw new DidError("That JWK is not an object");
  const spec = typeof jwk.crv === "string" ? JWK_CURVES[jwk.crv] : undefined;
  if (!spec || jwk.kty !== spec.kty) return undefined;
  const coordinate = (v: unknown) => { const b = strictBase64Url(v as string); if (b.length !== 32) throw new DidError("JWK coordinates are 32 bytes"); return b; };
  try {
    if (spec.curve === "Ed25519") return { curve: "Ed25519", publicKey: curveKey("Ed25519", coordinate(jwk.x)) };
    return { curve: spec.curve, publicKey: curveKey(spec.curve, concatBytes(Uint8Array.of(4), coordinate(jwk.x), coordinate(jwk.y))) };
  } catch (e) { throw e instanceof DidError && /point/.test(e.message) ? e : new DidError(`That ${spec.curve} JWK is malformed`); }
}

/**
 * The single key of a did:key or did:jwk, from the identifier itself, as the method specs build their
 * documents: did:key's `#<multibase>` and did:jwk's `#0`, both for authentication and assertionMethod
 * (a did:jwk marked `"use": "enc"` is for encryption only).
 */
function staticKey(did: string): DidKey {
  if (did.startsWith("did:key:")) {
    const mb = did.slice(8);
    const key = multikey(mb);
    if (!key) throw new DidError("That did:key is not an Ed25519, secp256k1 or P-256 key Ghostly can read");
    if (key.curve === "X25519") throw new DidError("That did:key is an X25519 encryption key: it cannot sign");
    return { id: `${did}#${mb}`, curve: key.curve, publicKey: key.publicKey, relationships: [...RELATIONSHIPS] };
  }
  let jwk: unknown;
  try { jwk = JSON.parse(utf8Decode(strictBase64Url(did.slice(8)))); } catch { throw new DidError("That did:jwk does not hold a JSON Web Key"); }
  if (!isObject(jwk)) throw new DidError("That did:jwk does not hold a JSON Web Key");
  if ("d" in jwk || "p" in jwk || "k" in jwk) throw new DidError("That did:jwk contains a private key. Never share it: make a new key");
  const key = jwkKey(jwk);
  if (!key) throw new DidError("That did:jwk is not an Ed25519, secp256k1 or P-256 key");
  return { id: `${did}#0`, curve: key.curve, publicKey: key.publicKey, relationships: jwk.use === "enc" ? [] : [...RELATIONSHIPS] };
}

/** The document of a did:key or did:jwk, which needs no network. */
export function staticDidDocument(did: string): DidDocumentView {
  const parsed = parseDid(did);
  if (parsed.method !== "key" && parsed.method !== "jwk") throw new DidError(`did:${parsed.method} is resolved over the network`);
  return { did: parsed.did, keys: [staticKey(parsed.did)], skipped: 0, services: [] };
}

// ---------------------------------------------------------------------------------------------
// Documents

/** An id as absolute `<did>#<fragment>`, from `#frag` or the absolute form; undefined for another DID's. */
function methodId(did: string, id: unknown): string | undefined {
  if (typeof id !== "string" || id.length > DID_MAX_LENGTH + 128) return undefined;
  const absolute = id.startsWith("#") ? `${did}${id}` : id;
  return absolute.startsWith(`${did}#`) && absolute.length > did.length + 1 && /^[\x21-\x7e]+$/.test(absolute) ? absolute : undefined;
}

/** Key material of one verification method: `publicKeyJwk`, `publicKeyMultibase` or (Ed25519 2018) `publicKeyBase58`. */
function methodKey(vm: Record<string, unknown>): { curve: DidCurve; publicKey: Uint8Array } | undefined {
  try {
    if (vm.publicKeyJwk !== undefined) return jwkKey(vm.publicKeyJwk);
    if (typeof vm.publicKeyMultibase === "string") {
      const key = multikey(vm.publicKeyMultibase);
      if (key && key.curve !== "X25519") return key;
      // Ed25519VerificationKey2020 documents written before multicodec prefixes carry the raw 32 bytes.
      if (!key && vm.type === "Ed25519VerificationKey2020" && vm.publicKeyMultibase.startsWith("z")) {
        const raw = base58.decode(vm.publicKeyMultibase.slice(1));
        if (raw.length === 32) return { curve: "Ed25519", publicKey: curveKey("Ed25519", raw) };
      }
      return undefined;
    }
    if (typeof vm.publicKeyBase58 === "string" && vm.type === "Ed25519VerificationKey2018" && vm.publicKeyBase58.length <= 64) {
      return { curve: "Ed25519", publicKey: curveKey("Ed25519", base58.decode(vm.publicKeyBase58)) };
    }
  } catch { return undefined; }
  return undefined;
}

const list = (value: unknown, name: string): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DidError(`The DID document's ${name} is not a list`);
  return value.slice(0, MAX_ENTRIES);
};

/**
 * A fetched or resolved DID document, strictly: it must be for exactly `did`; verification methods are
 * read from `verificationMethod` and from `authentication` / `assertionMethod` (references or embedded);
 * `GhostlyIdentityProof` services are kept. Keys Ghostly cannot use are counted in `skipped`.
 */
export function parseDidDocument(did: string, raw: unknown): DidDocumentView {
  if (!isObject(raw)) throw new DidError("The DID document is not a JSON object");
  if (raw.id !== did) throw new DidError(typeof raw.id === "string" ? `The DID document is for another DID (${raw.id.slice(0, 80)})` : "The DID document has no id");
  const keys = new Map<string, DidKey>();
  const unusable = new Set<string>();
  let skipped = 0;
  const add = (vm: unknown): string | undefined => {
    if (!isObject(vm)) { skipped++; return undefined; }
    const id = methodId(did, vm.id);
    if (!id) { skipped++; return undefined; }
    if (keys.has(id) || unusable.has(id)) return id;
    const key = methodKey(vm);
    if (!key) { unusable.add(id); skipped++; return id; }
    keys.set(id, { id, ...key, relationships: [] });
    return id;
  };
  for (const vm of list(raw.verificationMethod, "verificationMethod")) add(vm);
  for (const relationship of RELATIONSHIPS) {
    for (const entry of list(raw[relationship], relationship)) {
      const id = typeof entry === "string" ? methodId(did, entry) : add(entry);
      const key = id ? keys.get(id) : undefined;
      if (key && !key.relationships.includes(relationship)) key.relationships.push(relationship);
    }
  }
  const services: DidGhostlyService[] = [];
  for (const s of list(raw.service, "service")) {
    if (!isObject(s)) continue;
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const endpoint = s.serviceEndpoint;
    if (!types.includes(DID_GHOSTLY_SERVICE) || !isObject(endpoint)) continue;
    if (typeof endpoint.key === "string" && Z32_KEY.test(endpoint.key) && typeof endpoint.proof === "string" && HEX64.test(endpoint.proof))
      services.push({ id: typeof s.id === "string" ? s.id.slice(0, 200) : "", key: endpoint.key, proof: endpoint.proof });
  }
  return { did, keys: [...keys.values()].slice(0, MAX_ENTRIES), skipped, services: services.slice(0, 16) };
}

/** Keys that may sign for the DID. */
export const signingKeys = (doc: DidDocumentView) => doc.keys.filter(k => k.relationships.length > 0);

// ---------------------------------------------------------------------------------------------
// Signatures

/** JWS `alg` values Ghostly checks, and the curve each needs (RFC 8037, RFC 8812, RFC 7518, RFC 9864's Ed25519). */
export const DID_JWS_ALGS: Record<string, DidCurve> = { EdDSA: "Ed25519", Ed25519: "Ed25519", ES256K: "secp256k1", ES256: "P-256" };
/** The `alg` a person's tool should write for a key on this curve. */
export const didJwsAlg = (curve: DidCurve) => ({ Ed25519: "EdDSA", secp256k1: "ES256K", "P-256": "ES256" } as const)[curve];

export interface DidJws {
  alg: string;
  curve: DidCurve;
  kid?: string;
  /** RFC 7797: false signs the payload as it is (detached only). */
  b64: boolean;
  /** The protected header and payload segments as they were, for the signing input. */
  header: string;
  payload: string;
  signature: Uint8Array;
}

/** A compact JWS, attached or detached (`header..signature`), checked for shape only. */
export function parseDidJws(input: string): DidJws {
  const jws = typeof input === "string" ? input.trim() : "";
  if (!jws || jws.length > DID_JWS_MAX_LENGTH) throw new DidError("That is not a compact JWS");
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[2]) throw new DidError("A compact JWS has three parts separated by dots");
  let header: unknown;
  try {
    const bytes = strictBase64Url(parts[0]);
    if (bytes.length > 2048) throw new Error();
    header = JSON.parse(utf8Decode(bytes));
  } catch { throw new DidError("The JWS header is not base64url JSON"); }
  if (!isObject(header)) throw new DidError("The JWS header is not a JSON object");
  const alg = header.alg;
  if (typeof alg !== "string" || !DID_JWS_ALGS[alg]) throw new DidError(`The JWS uses ${typeof alg === "string" ? alg.slice(0, 16) : "no algorithm"}: Ghostly checks EdDSA, ES256K and ES256`);
  if (header.kid !== undefined && (typeof header.kid !== "string" || header.kid.length > DID_MAX_LENGTH + 128)) throw new DidError("The JWS kid is not a key id");
  if (header.b64 !== undefined && typeof header.b64 !== "boolean") throw new DidError("The JWS b64 header is not true or false");
  const crit = header.crit;
  if (crit !== undefined && (!Array.isArray(crit) || !crit.length || crit.some(c => c !== "b64"))) throw new DidError("The JWS requires an extension Ghostly does not know (crit)");
  const b64 = header.b64 !== false;
  if (!b64 && !(Array.isArray(crit) && crit.includes("b64"))) throw new DidError("A JWS with b64 false must list it in crit");
  if (!b64 && parts[1]) throw new DidError("A JWS with b64 false must be detached (header..signature)");
  let signature: Uint8Array;
  try { signature = strictBase64Url(parts[2]); } catch { throw new DidError("The JWS signature is not base64url"); }
  if (signature.length !== 64) throw new DidError(`A ${alg} signature is 64 bytes`);
  if (parts[1]) { try { strictBase64Url(parts[1]); } catch { throw new DidError("The JWS payload is not base64url"); } }
  return { alg, curve: DID_JWS_ALGS[alg], kid: header.kid as string | undefined, b64, header: parts[0], payload: parts[1], signature };
}

/** What a JWS signs for one candidate message: its own payload when attached (which must be that message). */
function signingInput(jws: DidJws, message: Uint8Array): Uint8Array | undefined {
  if (jws.payload) return bytesEqual(strictBase64Url(jws.payload), message) ? utf8Encode(`${jws.header}.${jws.payload}`) : undefined;
  return jws.b64 ? utf8Encode(`${jws.header}.${toBase64Url(message)}`) : concatBytes(utf8Encode(`${jws.header}.`), message);
}

function verifyWith(key: DidKey, signature: Uint8Array, message: Uint8Array, format: "compact" | "der" = "compact"): boolean {
  try {
    if (key.curve === "Ed25519") return format === "compact" && ed25519.verify(signature, message, key.publicKey);
    // ECDSA over SHA-256 of the message, either half of s (JOSE does not require low S).
    return (key.curve === "secp256k1" ? secp256k1 : p256).verify(signature, message, key.publicKey, { prehash: true, lowS: false, format });
  } catch { return false; }
}

export interface DidSignatureCheck { key: DidKey; alg: string }

const refusedKey = (key: DidKey) => new DidError(`Signed by ${key.id}, which the DID document does not list under authentication or assertionMethod`);

/**
 * Which key of `doc` made this JWS over one of `messages` (the statement, and the statement with a
 * trailing newline some tools add). With a `kid`, only that key is tried. Refused unless the key is
 * listed for authentication or assertionMethod.
 */
export function checkDidJws(input: string, messages: Uint8Array[], doc: DidDocumentView): DidSignatureCheck {
  const jws = parseDidJws(input);
  let candidates = doc.keys.filter(k => k.curve === jws.curve);
  if (jws.kid !== undefined) {
    const kid = methodId(doc.did, jws.kid);
    if (!kid) throw new DidError(`The JWS names key ${jws.kid.slice(0, 100)}, which is not a key of ${doc.did}`);
    candidates = candidates.filter(k => k.id === kid);
    if (!candidates.length) throw new DidError(doc.keys.some(k => k.id === kid) ? `Key ${kid} is not a ${jws.curve} key: the JWS says ${jws.alg}` : `The DID document lists no key ${kid}`);
  }
  if (!candidates.length) throw new DidError(`The DID document lists no ${jws.curve} key for ${jws.alg}`);
  let inputs: Uint8Array[];
  try { inputs = messages.map(m => signingInput(jws, m)).filter((m): m is Uint8Array => !!m); } catch { inputs = []; }
  if (!inputs.length) throw new DidError("The JWS carries another text: sign exactly the statement shown");
  for (const key of candidates) {
    if (!inputs.some(m => verifyWith(key, jws.signature, m))) continue;
    if (!key.relationships.length) throw refusedKey(key);
    return { key, alg: jws.alg };
  }
  throw new DidError("The JWS signature does not match: sign exactly the statement shown, with a key of this DID");
}

/**
 * Which key of `doc` made this raw signature over one of `messages`: Ed25519 (64 bytes), or ECDSA with
 * SHA-256 on secp256k1 or P-256 (64 bytes r‖s, or DER as OpenSSL writes it). `vm` narrows it to one key.
 * Returns the signature in its canonical form (r‖s for ECDSA).
 */
export function checkDidSignature(signature: Uint8Array, messages: Uint8Array[], doc: DidDocumentView, vm?: string): DidSignatureCheck & { signature: Uint8Array } {
  let candidates = doc.keys;
  if (vm !== undefined) {
    const id = methodId(doc.did, vm);
    if (!id) throw new DidError(`${vm.slice(0, 100)} is not a key of ${doc.did}`);
    candidates = candidates.filter(k => k.id === id);
    if (!candidates.length) throw new DidError(`The DID document lists no key ${id}`);
  }
  const der = signature.length !== 64 && signature[0] === 0x30;
  if (signature.length !== 64 && !der) throw new DidError("A signature is 64 bytes (or DER, for ECDSA)");
  for (const key of candidates) {
    if (der && key.curve === "Ed25519") continue;
    if (!messages.some(m => verifyWith(key, signature, m, der ? "der" : "compact"))) continue;
    if (!key.relationships.length) throw refusedKey(key);
    const canonical = der ? (key.curve === "secp256k1" ? secp256k1 : p256).Signature.fromBytes(signature, "der").toBytes("compact") : signature;
    return { key, alg: key.curve === "Ed25519" ? "Ed25519" : `ECDSA ${key.curve}`, signature: canonical };
  }
  throw new DidError("The signature does not match: sign exactly the statement shown, with a key of this DID");
}

/**
 * What a person pasted as a signature: a compact JWS, or a raw signature (hex, base64 or base64url),
 * optionally after the verification method id (`did:…#key-1 <signature>` or `#key-1 <signature>`).
 */
export type DidSignaturePaste = { kind: "jws"; jws: string } | { kind: "raw"; vm?: string; signature: Uint8Array };

export function parseDidSignaturePaste(pasted: string): DidSignaturePaste {
  const tokens = (typeof pasted === "string" ? pasted : "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new DidError("Paste the signature");
  // A JWS or signature split over several lines (base64 wrapped at 76 characters) comes back together.
  const vm = tokens.length > 1 && /^(did:|#)/.test(tokens[0]) ? tokens[0] : undefined;
  const text = (vm ? tokens.slice(1) : tokens).join("");
  if (text.split(".").length === 3) {
    if (vm) throw new DidError("Paste the JWS alone: its header names the key (kid)");
    return { kind: "jws", jws: text };
  }
  if (text.length > 400) throw new DidError("That is too long for a signature");
  let signature: Uint8Array | undefined;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) signature = Uint8Array.from(text.match(/../g)!, h => parseInt(h, 16));
  else {
    const url = text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    try { signature = strictBase64Url(url); } catch { signature = undefined; }
  }
  if (!signature) throw new DidError("That is not a signature: paste a JWS, or a signature in hex or base64");
  return { kind: "raw", vm, signature };
}

/** The statement bytes a signature may cover: exactly the statement, or with the newline `echo` adds. */
export const didSignedMessages = (statement: string) => [utf8Encode(statement), utf8Encode(`${statement}\n`)];
