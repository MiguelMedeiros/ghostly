import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { fromBase64Url, type X401CertificateCheck } from "@ghostly/core";

/**
 * The certificate check of a signed x401 request (WISP 3xx, step 3) on Node: the `x5c` chain, leaf first, leads to one
 * of the trusted roots (Node's default store: its bundled roots plus NODE_EXTRA_CA_CERTS), every certificate is valid
 * now, each one after the leaf is a CA and signed the one before it, and a DNS name in the leaf's subjectAltName is the
 * host called (never its subject's common name). The leaf's key must be P-256.
 *
 * Node has no path validator outside a TLS handshake, so what else RFC 5280 asks of a path is read here from each
 * certificate's DER: a CA's path length and DNS name constraints (the root's too), the leaf's key usage
 * (`digitalSignature`), an extended key usage that leaves servers out, and a critical extension this check does not know.
 */
export function x401CertificateCheck(roots: readonly string[] = defaultRoots()): X401CertificateCheck {
  let trusted: X509Certificate[] | undefined;
  return async (chain, host, now) => {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    let certs: X509Certificate[];
    try { certs = chain.map((der) => new X509Certificate(der)); } catch { return refuse("a certificate does not parse"); }
    for (const cert of certs) {
      if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) return refuse(`a certificate is not valid now (${cert.subject.replace(/\n/g, ", ")})`);
    }
    const [leaf] = certs;
    if (leaf.ca) return refuse("the leaf certificate is a CA");
    if (leaf.checkHost(host, { subject: "never" }) === undefined) return refuse(`the leaf certificate does not name ${host}`);
    for (let i = 0; i + 1 < certs.length; i++) {
      const child = certs[i], parent = certs[i + 1];
      if (!parent.ca || !child.checkIssued(parent) || !child.verify(parent.publicKey)) return refuse("the chain does not link");
    }
    trusted ??= roots.flatMap((pem) => { try { return [new X509Certificate(pem)]; } catch { return []; } });
    const last = certs[certs.length - 1];
    const anchor = trusted.find((root) => root.fingerprint256 === last.fingerprint256 ||
      (root.ca && Date.parse(root.validTo) >= now && last.checkIssued(root) && last.verify(root.publicKey)));
    if (!anchor) return refuse("the chain leads to no trusted root");
    const problem = pathProblem(certs, anchor.fingerprint256 === last.fingerprint256 ? undefined : anchor, host);
    if (problem) return refuse(problem);
    const key = leaf.publicKey;
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return refuse("the leaf key is not P-256");
    const jwk = key.export({ format: "jwk" });
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return refuse("the leaf key is not P-256");
    const publicKey = new Uint8Array(65);
    publicKey[0] = 4;
    publicKey.set(fromBase64Url(jwk.x), 1);
    publicKey.set(fromBase64Url(jwk.y), 33);
    return { ok: true, publicKey };
  };
}

function defaultRoots(): readonly string[] {
  const read = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  return read ? read("default") : tls.rootCertificates;
}

const OID = {
  keyUsage: "2.5.29.15", subjectAltName: "2.5.29.17", basicConstraints: "2.5.29.19", nameConstraints: "2.5.29.30",
  extendedKeyUsage: "2.5.29.37", anyExtendedKeyUsage: "2.5.29.37.0", serverAuth: "1.3.6.1.5.5.7.3.1",
};
/**
 * Extensions a certificate may mark critical: those read here, and those that only describe it (key ids, issuer
 * names, policies, where its revocation and issuer are, signed certificate timestamps).
 */
const KNOWN = new Set([
  OID.keyUsage, OID.subjectAltName, OID.basicConstraints, OID.nameConstraints, OID.extendedKeyUsage,
  "2.5.29.14", "2.5.29.18", "2.5.29.31", "2.5.29.32", "2.5.29.33", "2.5.29.35", "2.5.29.36", "2.5.29.54",
  "1.3.6.1.5.5.7.1.1", "1.3.6.1.4.1.11129.2.4.2",
]);
/** keyUsage's bit for signatures (RFC 5280 §4.2.1.3). */
const DIGITAL_SIGNATURE = 0;

interface Extensions {
  /** The OIDs of the extensions marked critical. */
  critical: string[];
  /** basicConstraints' pathLenConstraint. */
  pathLen?: number;
  /** Whether keyUsage sets a bit; absent with no keyUsage. */
  keyUsage?: (bit: number) => boolean;
  extendedKeyUsage?: string[];
  /** nameConstraints' DNS subtrees: another kind of name does not bound a DNS name. */
  permitted?: string[];
  excluded?: string[];
  /** subjectAltName's DNS names. */
  dns: string[];
}

/** The chain's first problem in its extensions (leaf first; `anchor` is the trusted root, when not in the chain). */
function pathProblem(certs: X509Certificate[], anchor: X509Certificate | undefined, host: string): string | undefined {
  const all = anchor ? [...certs, anchor] : certs;
  let read: Extensions[];
  try { read = all.map((cert) => extensionsOf(cert.raw)); } catch { return "a certificate's extensions do not parse"; }
  for (let i = 0; i < certs.length; i++) {
    if (read[i].critical.some((oid) => !KNOWN.has(oid))) return `a certificate has a critical extension this check does not know (${commonName(all[i])})`;
    const usages = read[i].extendedKeyUsage;
    if (usages && !usages.includes(OID.serverAuth) && !usages.includes(OID.anyExtendedKeyUsage)) return "a certificate's extended key usage is not for servers";
  }
  if (read[0].keyUsage && !read[0].keyUsage(DIGITAL_SIGNATURE)) return "the leaf certificate's key usage does not allow signing";
  const names = [...read[0].dns, host].map((name) => name.toLowerCase());
  for (let i = 1; i < all.length; i++) {
    const { pathLen, permitted, excluded } = read[i];
    // The CAs between this one and the leaf; a self-issued one does not count (RFC 5280 §4.2.1.9).
    const between = certs.slice(1, i).filter((cert) => cert.subject !== cert.issuer).length;
    if (pathLen !== undefined && between > pathLen) return `a CA's path length does not allow this chain (${commonName(all[i])})`;
    const outside = names.find((name) => (permitted && !permitted.some((base) => within(name, base))) || excluded?.some((base) => within(name, base)));
    if (outside) return `the leaf certificate names ${outside}, outside its CA's name constraints (${commonName(all[i])})`;
  }
  return undefined;
}

/** A DNS name within a constraint's base: the base itself or a name below it; below it only, when the base starts with `.`. */
function within(name: string, base: string): boolean {
  const b = base.toLowerCase();
  if (!b) return true;
  return b.startsWith(".") ? name.endsWith(b) : name === b || name.endsWith(`.${b}`);
}

const commonName = (cert: X509Certificate) => cert.subject.split("\n").find((part) => part.startsWith("CN="))?.slice(3) ?? cert.subject;

interface Tlv { tag: number; body: Uint8Array; end: number }

/** The DER element at `at`: low tag numbers and definite lengths, as a certificate has them. */
function tlv(bytes: Uint8Array, at: number): Tlv {
  const tag = bytes[at];
  let length = bytes[at + 1], start = at + 2;
  if (tag === undefined || length === undefined || (tag & 0x1f) === 0x1f) throw new Error("not DER");
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3) throw new Error("not DER");
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = bytes[start++];
      if (byte === undefined) throw new Error("not DER");
      length = length * 256 + byte;
    }
  }
  if (start + length > bytes.length) throw new Error("not DER");
  return { tag, body: bytes.subarray(start, start + length), end: start + length };
}

function children(body: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < body.length;) { const t = tlv(body, at); out.push(t); at = t.end; }
  return out;
}

function tagged(t: Tlv | undefined, tag: number): Tlv {
  if (!t || t.tag !== tag) throw new Error("not DER");
  return t;
}

const SEQUENCE = 0x30, BOOLEAN = 0x01, INTEGER = 0x02, BIT_STRING = 0x03, OCTET_STRING = 0x04, OBJECT_ID = 0x06;
/** `[3] extensions` of a TBSCertificate, a GeneralName's `dNSName`, nameConstraints' permitted and excluded subtrees. */
const EXTENSIONS = 0xa3, DNS_NAME = 0x82, PERMITTED = 0xa0, EXCLUDED = 0xa1;

function oidText(body: Uint8Array): string {
  const arcs: number[] = [];
  let value = 0;
  for (const byte of body) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) { arcs.push(value); value = 0; }
  }
  if (!arcs.length || value !== 0) throw new Error("not DER");
  const first = Math.min(2, Math.floor(arcs[0] / 40));
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join(".");
}

const dnsNames = (generalNames: Tlv[]) => generalNames.filter((n) => n.tag === DNS_NAME).map((n) => new TextDecoder().decode(n.body));

/** What the path check reads of a certificate's extensions, from its DER. */
function extensionsOf(raw: Uint8Array): Extensions {
  const tbs = tagged(children(tagged(tlv(raw, 0), SEQUENCE).body)[0], SEQUENCE);
  const out: Extensions = { critical: [], dns: [] };
  const holder = children(tbs.body).find((t) => t.tag === EXTENSIONS);
  if (!holder) return out;
  for (const extension of children(tagged(children(holder.body)[0], SEQUENCE).body)) {
    const [id, ...rest] = children(tagged(extension, SEQUENCE).body);
    const oid = oidText(tagged(id, OBJECT_ID).body);
    if (rest.length === 2 && tagged(rest[0], BOOLEAN).body[0] !== 0) out.critical.push(oid);
    const value = tlv(tagged(rest[rest.length - 1], OCTET_STRING).body, 0);
    if (oid === OID.basicConstraints) {
      const integer = children(tagged(value, SEQUENCE).body).find((t) => t.tag === INTEGER);
      if (integer) out.pathLen = integer.body.reduce((n, byte) => n * 256 + byte, 0);
    } else if (oid === OID.keyUsage) {
      const bits = tagged(value, BIT_STRING).body;
      out.keyUsage = (bit) => ((bits[1 + (bit >> 3)] ?? 0) & (0x80 >> (bit & 7))) !== 0;
    } else if (oid === OID.extendedKeyUsage) {
      out.extendedKeyUsage = children(tagged(value, SEQUENCE).body).map((t) => oidText(tagged(t, OBJECT_ID).body));
    } else if (oid === OID.subjectAltName) {
      out.dns = dnsNames(children(tagged(value, SEQUENCE).body));
    } else if (oid === OID.nameConstraints) {
      for (const subtrees of children(tagged(value, SEQUENCE).body)) {
        const bases = dnsNames(children(subtrees.body).map((subtree) => children(tagged(subtree, SEQUENCE).body)[0]).filter((t): t is Tlv => !!t));
        if (subtrees.tag === PERMITTED && bases.length) out.permitted = bases;
        if (subtrees.tag === EXCLUDED && bases.length) out.excluded = bases;
      }
    }
  }
  return out;
}
