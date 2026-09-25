import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual, fromBase64Url, fromZ32, toBase64Url, toZ32, utf8Encode } from "./bytes";
import { decodeTxtPacket, encodeTxtPacket, type NsRecord, type TxtRecord } from "./dns";
import type { Identity } from "./identity";
import { MAX_DNS_PACKET_BYTES, PacketTooLargeError, openRelayPayload, signRelayPayload } from "./pkarr";
import { DEFAULT_RELAYS, normalizeRelayUrl } from "./relay";

/**
 * did:dht (the DIF method, https://did-dht.com): a W3C DID document written as DNS records into the
 * Pkarr packet of an Ed25519 key, the BEP44 mutable item Ghostly already publishes chats under. This
 * module maps a document to that packet and back (strictly: a malformed packet is an error, never a
 * guess) and resolves a did:dht through Pkarr relays. WISP 3xx-did-dht describes Ghostly's use.
 */

export const DID_DHT_PREFIX = "did:dht:";
/** The TTL the spec recommends: Mainline's default record lifetime. */
export const DID_DHT_TTL = 7200;
/** The spec version this module writes and the only one it reads (`v=0`). */
export const DID_DHT_VERSION = "0";
/** A relay answer: 64 bytes of signature, 8 of sequence number, then at most 1000 of DNS packet. */
export const DID_DHT_MAX_PAYLOAD = 64 + 8 + MAX_DNS_PACKET_BYTES;

export interface DidDhtJwk {
  kty: "OKP" | "EC";
  crv: "Ed25519" | "secp256k1" | "P-256" | "X25519";
  x: string;
  y?: string;
  alg: string;
  kid: string;
}

export interface DidDhtVerificationMethod {
  id: string;
  type: "JsonWebKey";
  controller: string;
  publicKeyJwk: DidDhtJwk;
}

export interface DidDhtService {
  id: string;
  type: string;
  serviceEndpoint: string[];
  /** Registered extra properties (the spec's registry): which keys sign and encrypt for it. */
  sig?: string | string[];
  enc?: string | string[];
}

/** A did:dht document in W3C DID Core JSON: no `@context`, every reference fully qualified. */
export interface DidDhtDocument {
  id: string;
  controller?: string | string[];
  alsoKnownAs?: string[];
  verificationMethod: DidDhtVerificationMethod[];
  authentication?: string[];
  assertionMethod?: string[];
  keyAgreement?: string[];
  capabilityInvocation?: string[];
  capabilityDelegation?: string[];
  service?: DidDhtService[];
}

/** Why a did:dht could not be read: the message is meant for a person. */
export class DidDhtError extends Error {
  constructor(message: string, readonly code: "invalid-did" | "not-found" | "invalid-signature" | "malformed" | "unreachable") {
    super(message);
    this.name = "DidDhtError";
  }
}

const malformed = (detail: string) => new DidDhtError(`The did:dht document is malformed: ${detail}`, "malformed");

// ── Identifiers ───────────────────────────────────────────────────────────────────────────────────────

/** `did:dht:<z-base-32 of the Ed25519 public key>`. */
export function didDhtFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("A did:dht identity key is 32 bytes of Ed25519 public key");
  return DID_DHT_PREFIX + toZ32(publicKey);
}

/** The identity key of a did:dht. Only the exact DID: no path, query or fragment, canonical z-base-32. */
export function didDhtKey(did: string): { z32: string; publicKey: Uint8Array } {
  const invalid = () => new DidDhtError("This is not a valid did:dht", "invalid-did");
  if (typeof did !== "string" || !did.startsWith(DID_DHT_PREFIX)) throw invalid();
  const z32 = did.slice(DID_DHT_PREFIX.length);
  if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(z32)) throw invalid();
  const publicKey = fromZ32(z32);
  // 52 characters carry 260 bits: the last four must be zero, or two DIDs would name one key.
  if (toZ32(publicKey) !== z32) throw invalid();
  try {
    ed25519.Point.fromBytes(publicKey);
  } catch {
    throw invalid();
  }
  return { z32, publicKey };
}

// ── Documents ─────────────────────────────────────────────────────────────────────────────────────────

const KEY_TYPES = [
  { kty: "OKP", crv: "Ed25519", alg: "EdDSA" },
  { kty: "EC", crv: "secp256k1", alg: "ES256K" },
  { kty: "EC", crv: "P-256", alg: "ES256" },
  { kty: "OKP", crv: "X25519", alg: "ECDH-ES+A256KW" },
] as const;

const RELATIONSHIPS = [
  ["auth", "authentication"],
  ["asm", "assertionMethod"],
  ["agm", "keyAgreement"],
  ["inv", "capabilityInvocation"],
  ["del", "capabilityDelegation"],
] as const;

/**
 * The document of an identity key alone, as the spec's Create step makes it: the key as `#0`, with the
 * four relationships it requires (authentication, assertion, capability invocation and delegation).
 * `alsoKnownAs` adds other identifiers of the same subject (URIs), which the document makes public.
 */
export function didDhtDocument(publicKey: Uint8Array, options: { alsoKnownAs?: string[] } = {}): DidDhtDocument {
  const id = didDhtFromPublicKey(publicKey);
  const key = `${id}#0`;
  return {
    id,
    ...(options.alsoKnownAs?.length ? { alsoKnownAs: [...options.alsoKnownAs] } : {}),
    verificationMethod: [{
      id: key,
      type: "JsonWebKey",
      controller: id,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(publicKey), alg: "EdDSA", kid: "0" },
    }],
    authentication: [key],
    assertionMethod: [key],
    capabilityInvocation: [key],
    capabilityDelegation: [key],
  };
}

/** RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order. */
export function jwkThumbprint(jwk: Pick<DidDhtJwk, "kty" | "crv" | "x" | "y">): string {
  const members = jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return toBase64Url(sha256(utf8Encode(JSON.stringify(members))));
}

function publicKeyBytes(type: number, jwk: DidDhtJwk): Uint8Array {
  const x = fromBase64Url(jwk.x);
  if (type === 0 || type === 3) return x;
  // Compressed point: the x-coordinate and the sign of y (the spec's size rule).
  const curve = type === 1 ? secp256k1 : p256;
  return curve.Point.fromAffine({ x: bigintOf(x), y: bigintOf(fromBase64Url(jwk.y ?? "")) }).toBytes(true);
}

function bigintOf(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function jwkOf(type: number, bytes: Uint8Array, alg: string, kid: string): DidDhtJwk {
  const kind = KEY_TYPES[type];
  if (type === 0) {
    if (bytes.length !== 32) throw malformed("an Ed25519 key is not 32 bytes");
    try { ed25519.Point.fromBytes(bytes); } catch { throw malformed("an Ed25519 key is not a point of the curve"); }
    return { kty: "OKP", crv: "Ed25519", x: toBase64Url(bytes), alg, kid };
  }
  if (type === 3) {
    if (bytes.length !== 32) throw malformed("an X25519 key is not 32 bytes");
    return { kty: "OKP", crv: "X25519", x: toBase64Url(bytes), alg, kid };
  }
  if (bytes.length !== 33 && bytes.length !== 65) throw malformed(`a ${kind.crv} key is neither a compressed nor an uncompressed point`);
  let raw: Uint8Array;
  try {
    raw = (type === 1 ? secp256k1 : p256).Point.fromBytes(bytes).toBytes(false);
  } catch {
    throw malformed(`a ${kind.crv} key is not a point of the curve`);
  }
  return { kty: "EC", crv: kind.crv, x: toBase64Url(raw.subarray(1, 33)), y: toBase64Url(raw.subarray(33)), alg, kid };
}

// ── Document → DNS records ────────────────────────────────────────────────────────────────────────────

export interface DidDhtPacketOptions {
  /** Type indexing (`_typ._did.`), integers from the spec's registry. */
  types?: number[];
  /** Authoritative gateways, as NS records of the root name. */
  gateways?: string[];
  /**
   * Other records of the same key. A key has exactly one packet: whatever else it publishes goes in
   * with the document, and the whole must fit the 1000 bytes.
   */
  extra?: TxtRecord[];
}

const fragmentOf = (documentId: string, ref: string, what: string): string => {
  if (!ref.startsWith(`${documentId}#`)) throw new Error(`${what} ${ref} is not a fragment of ${documentId}`);
  const fragment = ref.slice(documentId.length + 1);
  if (!FRAGMENT.test(fragment)) throw new Error(`${what} ${ref} has an unusable fragment`);
  return fragment;
};

const listValue = (values: string[], what: string): string => {
  for (const v of values) if (!v || /[,;\s]/.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot be written into a did:dht record`);
  return values.join(",");
};

/**
 * The DNS records of a document, in the spec's layout (names `_did.<ID>.` and `_kN._did.`). The root
 * record comes after the records it names, gateways last: the order @web5/dids writes, and the only one
 * it reads correctly (it resolves `vm`/`auth` references in packet order). Order-free readers don't mind.
 */
export function didDhtRecords(document: DidDhtDocument, options: DidDhtPacketOptions = {}): (TxtRecord | NsRecord)[] {
  const { z32, publicKey } = didDhtKey(document.id);
  const methods = document.verificationMethod;
  const first = methods[0];
  if (!first || first.id !== `${document.id}#0` || first.publicKeyJwk.crv !== "Ed25519" || !bytesEqual(fromBase64Url(first.publicKeyJwk.x), publicKey)) {
    throw new Error("The first verification method of a did:dht document is its identity key, #0");
  }

  const aliases = new Map<string, string>();
  const keyRecords: TxtRecord[] = methods.map((method, index) => {
    const alias = `k${index}`;
    if (aliases.has(method.id)) throw new Error(`Verification method ${method.id} appears twice`);
    aliases.set(method.id, alias);
    const fragment = fragmentOf(document.id, method.id, "Verification method");
    const type = KEY_TYPES.findIndex((k) => k.crv === method.publicKeyJwk.crv);
    if (type < 0) throw new Error(`Key type ${method.publicKeyJwk.crv} has no did:dht index`);
    const jwk = method.publicKeyJwk;
    const parts: string[] = [];
    // The identity key's id is always 0, and one that is the thumbprint can be computed back: both are left out.
    if (index > 0 && fragment !== jwkThumbprint(jwk)) parts.push(`id=${fragment}`);
    parts.push(`t=${type}`, `k=${toBase64Url(publicKeyBytes(type, jwk))}`);
    if (jwk.alg !== KEY_TYPES[type].alg) parts.push(`a=${jwk.alg}`);
    if (method.controller !== document.id) parts.push(`c=${listValue([method.controller], "Controller")}`);
    return { name: `_${alias}._did.`, value: parts.join(";"), ttl: DID_DHT_TTL };
  });

  const services = document.service ?? [];
  const serviceRecords: TxtRecord[] = services.map((service, index) => {
    const parts = [
      `id=${fragmentOf(document.id, service.id, "Service")}`,
      `t=${listValue([service.type], "Service type")}`,
      `se=${listValue(service.serviceEndpoint, "Service endpoint")}`,
    ];
    for (const extra of ["sig", "enc"] as const) {
      const v = service[extra];
      if (v !== undefined) parts.push(`${extra}=${listValue(Array.isArray(v) ? v : [v], `Service ${extra}`)}`);
    }
    return { name: `_s${index}._did.`, value: parts.join(";"), ttl: DID_DHT_TTL };
  });

  const root = [`v=${DID_DHT_VERSION}`, `vm=${keyRecords.map((_, i) => `k${i}`).join(",")}`];
  for (const [short, property] of RELATIONSHIPS) {
    const refs = document[property] ?? [];
    if (refs.length === 0) continue;
    root.push(`${short}=${refs.map((ref) => {
      const alias = aliases.get(ref);
      if (!alias) throw new Error(`${property} refers to ${ref}, which is not a verification method of the document`);
      return alias;
    }).join(",")}`);
  }
  if (serviceRecords.length) root.push(`svc=${serviceRecords.map((_, i) => `s${i}`).join(",")}`);

  const records: (TxtRecord | NsRecord)[] = [];
  if (document.alsoKnownAs?.length) records.push({ name: "_aka._did.", value: listValue(document.alsoKnownAs, "Also-known-as"), ttl: DID_DHT_TTL });
  if (document.controller !== undefined) {
    const controllers = Array.isArray(document.controller) ? document.controller : [document.controller];
    records.push({ name: "_cnt._did.", value: listValue(controllers, "Controller"), ttl: DID_DHT_TTL });
  }
  records.push(...keyRecords, ...serviceRecords);
  if (options.types?.length) {
    for (const t of options.types) if (!Number.isSafeInteger(t) || t < 0) throw new Error(`Type ${t} is not a registry integer`);
    records.push({ name: "_typ._did.", value: `id=${options.types.join(",")}`, ttl: DID_DHT_TTL });
  }
  records.push({ name: `_did.${z32}.`, value: root.join(";"), ttl: DID_DHT_TTL });
  for (const host of options.gateways ?? []) records.push({ type: "NS", name: `_did.${z32}.`, host, ttl: DID_DHT_TTL });
  records.push(...(options.extra ?? []));
  return records;
}

/** The compressed, authoritative DNS packet of a document. Throws `PacketTooLargeError` past 1000 bytes. */
export function encodeDidDhtPacket(document: DidDhtDocument, options: DidDhtPacketOptions = {}): Uint8Array {
  const packet = encodeTxtPacket(didDhtRecords(document, options), { authoritative: true });
  if (packet.length > MAX_DNS_PACKET_BYTES) throw new PacketTooLargeError(packet.length);
  return packet;
}

/**
 * The relay payload of a document: its packet, signed by the identity key. `seq` is the BEP44 sequence
 * number, which did:dht defines as the UNIX time in seconds (Ghostly's chat records use microseconds).
 */
export function signDidDhtPacket(identity: Identity, dnsPacket: Uint8Array, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("A did:dht sequence number is a UNIX time in seconds");
  return signRelayPayload(identity, dnsPacket, BigInt(seq));
}

// ── DNS records → document ────────────────────────────────────────────────────────────────────────────

const FRAGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
const ALG = /^[A-Za-z0-9+._-]{1,32}$/;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s,;]+$/;

/** `a=1;b=x,y`: each property once, names in lower case. */
function properties(value: string, where: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of value.split(";")) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (at <= 0 || !/^[a-z]+$/.test(name)) throw malformed(`${where} has a property that is not name=value`);
    if (out.has(name)) throw malformed(`${where} has ${name} twice`);
    out.set(name, pair.slice(at + 1));
  }
  return out;
}

function list(value: string | undefined, where: string, item: RegExp): string[] {
  if (value === undefined) return [];
  const items = value.split(",");
  for (const v of items) if (!item.test(v)) throw malformed(`${where} has an unexpected value`);
  return items;
}

export interface DecodedDidDht {
  document: DidDhtDocument;
  /** The root record says `deactivated`: the document holds the id alone. */
  deactivated: boolean;
  /** Type indexing integers (`_typ._did.`), when present. */
  types?: number[];
}

/**
 * The document in a did:dht DNS packet. Other records of the key (anything not ending in `_did`) are
 * ignored, and so are did:dht records this version does not know (`_prv`, future ones); everything it
 * does know must be well formed and consistent, or the packet is refused.
 */
export function decodeDidDhtPacket(did: string, dnsPacket: Uint8Array): DecodedDidDht {
  const { z32, publicKey } = didDhtKey(did);
  let txt: TxtRecord[];
  try {
    txt = decodeTxtPacket(dnsPacket);
  } catch (error) {
    throw malformed(`not a DNS packet (${error instanceof Error ? error.message : String(error)})`);
  }

  // `_k0._did` as the spec writes it, or `_k0._did.<ID>` as a Pkarr client that appends its origin does.
  const byName = new Map<string, string>();
  let rootValue: string | undefined;
  for (const record of txt) {
    const name = record.name.toLowerCase().replace(/\.$/, "");
    if (name === `_did.${z32}`) {
      if (rootValue !== undefined) throw malformed("two root records");
      rootValue = record.value;
      continue;
    }
    const match = /^(_[a-z0-9]+)\._did(?:\.([a-z0-9]+))?$/.exec(name);
    if (!match || (match[2] !== undefined && match[2] !== z32)) continue;
    if (byName.has(match[1])) throw malformed(`two ${match[1]} records`);
    byName.set(match[1], record.value);
  }
  if (rootValue === undefined) throw malformed("no root record");
  if (rootValue === "deactivated") return { document: { id: did, verificationMethod: [] }, deactivated: true };

  const root = properties(rootValue, "the root record");
  if (root.get("v") !== DID_DHT_VERSION) throw malformed(`version ${root.get("v") ?? "(none)"} is not supported`);
  const vm = list(root.get("vm"), "the root record's vm", /^k\d{1,3}$/);
  if (!vm.includes("k0")) throw malformed("the identity key k0 is not listed");
  if (new Set(vm).size !== vm.length) throw malformed("a key is listed twice");

  const document: DidDhtDocument = { id: did, verificationMethod: [] };
  const methodIds = new Map<string, string>();
  for (const alias of vm) {
    const value = byName.get(`_${alias}`);
    if (value === undefined) throw malformed(`the key ${alias} has no record`);
    const props = properties(value, `the key ${alias}`);
    const type = Number(props.get("t"));
    if (!/^[0-3]$/.test(props.get("t") ?? "")) throw malformed(`the key ${alias} has an unknown type`);
    const alg = props.get("a") ?? KEY_TYPES[type].alg;
    if (!ALG.test(alg)) throw malformed(`the key ${alias} has an unusable algorithm`);
    const k = props.get("k") ?? "";
    const bytes = /^[A-Za-z0-9_-]+$/.test(k) ? fromBase64Url(k) : new Uint8Array();
    if (bytes.length === 0 || toBase64Url(bytes) !== k) throw malformed(`the key ${alias} is not unpadded base64url`);
    const controller = props.get("c") ?? did;
    if (!DID.test(controller)) throw malformed(`the key ${alias} has a controller that is not a DID`);

    let fragment: string;
    let jwk: DidDhtJwk;
    if (alias === "k0") {
      if (type !== 0 || !bytesEqual(bytes, publicKey)) throw malformed("k0 is not the DID's identity key");
      if (props.has("id") && props.get("id") !== "0") throw malformed("the identity key's id is not 0");
      fragment = "0";
      jwk = jwkOf(type, bytes, alg, fragment);
    } else {
      const provisional = jwkOf(type, bytes, alg, "");
      fragment = props.get("id") ?? jwkThumbprint(provisional);
      if (!FRAGMENT.test(fragment)) throw malformed(`the key ${alias} has an unusable id`);
      jwk = { ...provisional, kid: fragment };
    }
    const id = `${did}#${fragment}`;
    if ([...methodIds.values()].includes(id)) throw malformed(`two keys have the id ${fragment}`);
    methodIds.set(alias, id);
    document.verificationMethod.push({ id, type: "JsonWebKey", controller, publicKeyJwk: jwk });
  }

  for (const [short, property] of RELATIONSHIPS) {
    const refs = list(root.get(short), `the root record's ${short}`, /^k\d{1,3}$/);
    if (refs.length === 0) continue;
    document[property] = refs.map((alias) => {
      const id = methodIds.get(alias);
      if (!id) throw malformed(`${short} names ${alias}, which is not a listed key`);
      return id;
    });
  }

  const services = list(root.get("svc"), "the root record's svc", /^s\d{1,3}$/);
  if (new Set(services).size !== services.length) throw malformed("a service is listed twice");
  for (const alias of services) {
    const value = byName.get(`_${alias}`);
    if (value === undefined) throw malformed(`the service ${alias} has no record`);
    const props = properties(value, `the service ${alias}`);
    const fragment = props.get("id") ?? "";
    const type = props.get("t") ?? "";
    if (!FRAGMENT.test(fragment)) throw malformed(`the service ${alias} has an unusable id`);
    if (!/^[A-Za-z0-9._:/-]{1,64}$/.test(type)) throw malformed(`the service ${alias} has an unusable type`);
    const service: DidDhtService = { id: `${did}#${fragment}`, type, serviceEndpoint: list(props.get("se") ?? "", `the service ${alias}'s endpoint`, URI) };
    for (const extra of ["sig", "enc"] as const) {
      const v = props.get(extra);
      if (v !== undefined) service[extra] = v.includes(",") ? list(v, `the service ${alias}'s ${extra}`, /^[^\s,;]+$/) : v;
    }
    if (document.service?.some((s) => s.id === service.id)) throw malformed(`two services have the id ${fragment}`);
    (document.service ??= []).push(service);
  }

  const controller = byName.get("_cnt");
  if (controller !== undefined) {
    const controllers = list(controller, "the controller record", DID);
    document.controller = controllers.length === 1 ? controllers[0] : controllers;
  }
  const aka = byName.get("_aka");
  if (aka !== undefined) document.alsoKnownAs = list(aka, "the also-known-as record", URI);

  const decoded: DecodedDidDht = { document, deactivated: false };
  const typ = byName.get("_typ");
  if (typ !== undefined) {
    const props = properties(typ, "the type record");
    decoded.types = list(props.get("id"), "the type record", /^\d{1,9}$/).map(Number);
  }
  return decoded;
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────────────

export interface DidDhtFetchResponse { status: number; bytes: Uint8Array }
/** A bounded GET (the identity proofs' `ctx.fetch` is one). */
export type DidDhtFetch = (url: string, options?: { maxBytes?: number; signal?: AbortSignal; redirect?: "error" }) => Promise<DidDhtFetchResponse>;

export interface ResolveDidDhtOptions {
  fetch: DidDhtFetch;
  /** Pkarr relays (or did:dht gateways, which answer the same GET) to ask in turn. Default: `DEFAULT_RELAYS`. */
  relays?: string[];
  signal?: AbortSignal;
}

export interface DidDhtMetadata {
  /** The BEP44 sequence number. */
  versionId: string;
  /** When it was published, from the sequence number. */
  updated: string;
  deactivated?: true;
  types?: number[];
}

export interface DidDhtResolution {
  document: DidDhtDocument;
  metadata: DidDhtMetadata;
  /** The relay that answered. */
  relay: string;
}

/** A packet opened and decoded: the signature is the identity key's, the document well formed. */
export function openDidDhtPayload(did: string, payload: Uint8Array): DecodedDidDht & { seq: bigint } {
  const { z32 } = didDhtKey(did);
  let opened: { seq: bigint; dnsPacket: Uint8Array };
  try {
    opened = openRelayPayload(z32, payload);
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid signature") {
      throw new DidDhtError("The did:dht record is not signed by the DID's key", "invalid-signature");
    }
    throw malformed(error instanceof Error ? error.message : String(error));
  }
  return { ...decodeDidDhtPacket(did, opened.dnsPacket), seq: opened.seq };
}

/** The spec's `seq` is in seconds; Pkarr clients write microseconds. Either way, a date. */
function seqDate(seq: bigint): string {
  const n = Number(seq);
  const ms = n < 1e11 ? n * 1000 : n < 1e14 ? n : n / 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/**
 * Resolves a did:dht through Pkarr relays: one GET per relay, in turn, the next only when one has
 * nothing, fails or serves a packet that does not check out. The answer is bounded to a BEP44 item,
 * its signature checked against the DID's key and its records parsed strictly. A deactivated DID
 * resolves (`metadata.deactivated`); everything else that goes wrong throws a `DidDhtError`.
 */
export async function resolveDidDht(did: string, options: ResolveDidDhtOptions): Promise<DidDhtResolution> {
  const { z32 } = didDhtKey(did);
  const relays = [...new Set((options.relays ?? DEFAULT_RELAYS).map(normalizeRelayUrl).filter((r): r is string => r !== null))];
  if (relays.length === 0) throw new DidDhtError("No Pkarr relay to ask", "unreachable");

  let notFound = false;
  let refused: DidDhtError | undefined;
  for (const relay of relays) {
    options.signal?.throwIfAborted();
    let response: DidDhtFetchResponse;
    try {
      response = await options.fetch(`${relay}/${z32}`, { maxBytes: DID_DHT_MAX_PAYLOAD, signal: options.signal, redirect: "error" });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      continue;
    }
    if (response.status === 404) {
      notFound = true;
      continue;
    }
    if (response.status !== 200) continue;
    try {
      const opened = openDidDhtPayload(did, response.bytes);
      return {
        document: opened.document,
        metadata: {
          versionId: opened.seq.toString(),
          updated: seqDate(opened.seq),
          ...(opened.deactivated ? { deactivated: true as const } : {}),
          ...(opened.types ? { types: opened.types } : {}),
        },
        relay,
      };
    } catch (error) {
      if (!(error instanceof DidDhtError)) throw error;
      refused = error;
    }
  }
  if (refused) throw refused;
  if (notFound) throw new DidDhtError("No document is published for this did:dht", "not-found");
  throw new DidDhtError("No Pkarr relay answered for this did:dht", "unreachable");
}
