import { p256 } from "@noble/curves/nist.js";
import { concatBytes, toBase64, toBase64Url, utf8Encode } from "../../src/bytes";

/*
 * Test certificates for x401 verifiers: a P-256 CA and leaves it signs, written as DER by hand (no openssl, no key on
 * disk). Enough X.509 for a signed request's `x5c`: subject and issuer common names, validity, the key, basic
 * constraints with a path length, the leaf's DNS names, key usage, extended key usage, DNS name constraints, and any
 * other extension a test hands in.
 */

const der = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const body = concatBytes(...parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concatBytes(new Uint8Array([tag, ...length]), body);
};
const seq = (...parts: Uint8Array[]) => der(0x30, ...parts);
const oid = (bytes: number[]) => der(0x06, new Uint8Array(bytes));
const OID = {
  ecPublicKey: oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
  prime256v1: oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
  ecdsaSha256: oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
  commonName: oid([0x55, 0x04, 0x03]),
  basicConstraints: oid([0x55, 0x1d, 0x13]),
  subjectAltName: oid([0x55, 0x1d, 0x11]),
  keyUsage: oid([0x55, 0x1d, 0x0f]),
  extendedKeyUsage: oid([0x55, 0x1d, 0x25]),
  nameConstraints: oid([0x55, 0x1d, 0x1e]),
};

/** Extended key usages, as their OIDs' bytes. */
export const EKU = {
  serverAuth: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01],
  clientAuth: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02],
  emailProtection: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04],
  any: [0x55, 0x1d, 0x25, 0x00],
} as const;

/** keyUsage bits, numbered as RFC 5280 does (digitalSignature is 0). */
export const KEY_USAGE = { digitalSignature: 0, keyEncipherment: 2, keyAgreement: 4, keyCertSign: 5, cRLSign: 6 } as const;
const name = (cn: string) => seq(der(0x31, seq(OID.commonName, der(0x0c, utf8Encode(cn)))));
const time = (ms: number) => der(0x18, utf8Encode(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
const BOOLEAN_TRUE = der(0x01, new Uint8Array([0xff]));
const extension = (id: Uint8Array, critical: boolean, value: Uint8Array) => seq(id, ...(critical ? [BOOLEAN_TRUE] : []), der(0x04, value));

/** A BIT STRING of the bits named, most significant first, without trailing zero bits. */
function bits(named: number[]): Uint8Array {
  const length = Math.max(...named) + 1, bytes = new Uint8Array(Math.ceil(length / 8));
  for (const bit of named) bytes[bit >> 3] |= 0x80 >> (bit & 7);
  return der(0x03, new Uint8Array([bytes.length * 8 - length]), bytes);
}

export interface TestCertificate { der: Uint8Array; secret: Uint8Array; publicKey: Uint8Array }

let serial = 1;

export function testCertificate(options: {
  subject: string;
  dns?: string[];
  ca?: boolean;
  issuer?: TestCertificate & { subject: string };
  notBefore?: number;
  notAfter?: number;
  /** The P-256 key to certify; a fresh one when absent. */
  secret?: Uint8Array;
  /** basicConstraints' pathLenConstraint, for a CA. */
  pathLen?: number;
  /** keyUsage, critical, with these bits (`KEY_USAGE`). */
  keyUsage?: number[];
  /** extendedKeyUsage, with these usages (`EKU`). */
  eku?: (readonly number[])[];
  /** nameConstraints, critical: DNS subtrees permitted and excluded. */
  names?: { permitted?: string[]; excluded?: string[] };
  /** More extensions, as given: `{ oid: bytes, critical }`, valued with an empty SEQUENCE. */
  extensions?: { oid: number[]; critical: boolean }[];
}): TestCertificate & { subject: string } {
  const secret = options.secret ?? p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, false);
  const extensions: Uint8Array[] = [];
  if (options.ca) {
    const pathLen = options.pathLen === undefined ? [] : [der(0x02, new Uint8Array([options.pathLen]))];
    extensions.push(extension(OID.basicConstraints, true, seq(BOOLEAN_TRUE, ...pathLen)));
  }
  if (options.dns?.length) extensions.push(extension(OID.subjectAltName, false, seq(...options.dns.map((d) => der(0x82, utf8Encode(d))))));
  if (options.keyUsage) extensions.push(extension(OID.keyUsage, true, bits(options.keyUsage)));
  if (options.eku) extensions.push(extension(OID.extendedKeyUsage, false, seq(...options.eku.map((usage) => oid([...usage])))));
  if (options.names) {
    const subtrees = (tag: number, dns?: string[]) => dns ? [der(tag, ...dns.map((d) => seq(der(0x82, utf8Encode(d)))))] : [];
    extensions.push(extension(OID.nameConstraints, true, seq(...subtrees(0xa0, options.names.permitted), ...subtrees(0xa1, options.names.excluded))));
  }
  for (const { oid: id, critical } of options.extensions ?? []) extensions.push(extension(oid(id), critical, seq()));
  const tbs = seq(
    der(0xa0, der(0x02, new Uint8Array([2]))),
    der(0x02, new Uint8Array([serial++ & 0x7f])),
    seq(OID.ecdsaSha256),
    name(options.issuer?.subject ?? options.subject),
    seq(time(options.notBefore ?? Date.now() - 86_400_000), time(options.notAfter ?? Date.now() + 86_400_000)),
    name(options.subject),
    seq(seq(OID.ecPublicKey, OID.prime256v1), der(0x03, new Uint8Array([0]), publicKey)),
    ...(extensions.length ? [der(0xa3, seq(...extensions))] : []),
  );
  const signature = p256.sign(tbs, options.issuer?.secret ?? secret, { format: "der" });
  return { der: seq(tbs, seq(OID.ecdsaSha256), der(0x03, new Uint8Array([0]), signature)), secret, publicKey, subject: options.subject };
}

export const pem = (cert: TestCertificate) =>
  `-----BEGIN CERTIFICATE-----\n${toBase64(cert.der).match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

/** A JAR (`oauth-authz-req+jwt`) signed by `signer`, with `x5c` as given (leaf first). */
export function signedRequest(payload: Record<string, unknown>, signer: Uint8Array, x5c: Uint8Array[], header: Record<string, unknown> = {}): string {
  const json = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));
  const head = json({ alg: "ES256", typ: "oauth-authz-req+jwt", x5c: x5c.map(toBase64), ...header });
  const body = json(payload);
  return `${head}.${body}.${toBase64Url(p256.sign(utf8Encode(`${head}.${body}`), signer))}`;
}
