import { p256 } from "@noble/curves/nist.js";
import { concatBytes, toBase64, toBase64Url, utf8Encode } from "../../src/bytes";

/*
 * Test certificates for x401 verifiers: a P-256 CA and leaves it signs, written as DER by hand (no openssl, no key on
 * disk). Enough X.509 for a signed request's `x5c`: subject and issuer common names, validity, the key, basic
 * constraints, and the leaf's DNS names.
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
};
const name = (cn: string) => seq(der(0x31, seq(OID.commonName, der(0x0c, utf8Encode(cn)))));
const time = (ms: number) => der(0x18, utf8Encode(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
const BOOLEAN_TRUE = der(0x01, new Uint8Array([0xff]));

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
}): TestCertificate & { subject: string } {
  const secret = options.secret ?? p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, false);
  const extensions: Uint8Array[] = [];
  if (options.ca) extensions.push(seq(OID.basicConstraints, BOOLEAN_TRUE, der(0x04, seq(BOOLEAN_TRUE))));
  if (options.dns?.length) extensions.push(seq(OID.subjectAltName, der(0x04, seq(...options.dns.map((d) => der(0x82, utf8Encode(d)))))));
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
