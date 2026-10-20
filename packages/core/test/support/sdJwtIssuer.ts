import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "../../src/bytes";
import type { X401HolderJwk } from "../../src/x401Credential";

/**
 * A test issuer of SD-JWT VCs (WISP 3xx): a person with a made-up licence, never a real document. `disclose` names the
 * claims that become disclosures; the others stay plain in the JWT. `nationalities` is an array whose elements are
 * disclosed one by one, and `address` an object with its own `_sd`.
 */
const issuer = p256.keygen();
const b64json = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));
let salt = 0;

export function disclosure(...entry: unknown[]): { text: string; digest: string } {
  const text = b64json([`salt-${++salt}`, ...entry]);
  return { text, digest: toBase64Url(sha256(utf8Encode(text))) };
}

/** `sd` adds digests to the top `_sd`, for disclosures given in `extra`. */
export interface TestCredential { header?: Record<string, unknown>; payload?: Record<string, unknown>; extra?: string[]; sd?: string[]; holder: X401HolderJwk }

export function issueSdJwtVc({ header = {}, payload = {}, extra = [], sd = [], holder }: TestCredential): string {
  const given = disclosure("given_name", "Alice");
  const licence = disclosure("licence_number", "TEST-0001");
  const street = disclosure("street", "1 Test Road");
  const nationality = disclosure("XX");
  const claims = {
    iss: "https://issuer.example", vct: "https://issuer.example/licence", iat: 1_760_000_000, exp: 4_102_444_800,
    cnf: { jwk: holder }, _sd_alg: "sha-256", family_name: "Test",
    _sd: [given.digest, licence.digest, toBase64Url(sha256(utf8Encode("a decoy"))), ...sd],
    address: { country: "XX", _sd: [street.digest] },
    nationalities: [{ "...": nationality.digest }, "YY"],
    ...payload,
  };
  const head = b64json({ alg: "ES256", typ: "dc+sd-jwt", ...header });
  const body = b64json(claims);
  const signature = toBase64Url(p256.sign(utf8Encode(`${head}.${body}`), issuer.secretKey));
  return [`${head}.${body}.${signature}`, given.text, licence.text, street.text, nationality.text, ...extra, ""].join("~");
}
