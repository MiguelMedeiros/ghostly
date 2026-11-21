import type { Translate, TranslationKey } from "../contexts/I18nContext";
import { knownErrorText } from "./errorText";

/*
 * Why a DID, its document or a signature made with it is refused (packages/core did.ts and didDht.ts, packages/browser
 * proofs/did.ts and proofs/providers/did.ts), said in the app's language: Add's preview and signature step, and a
 * contact's check. The engine keeps throwing its English (the CLI shows it as it is); errorText.ts says the ones it
 * knows, and these are the rest. They read in English in every language until 2026-11-18.
 */

interface Refusal {
  match: RegExp;
  key: TranslationKey;
  /** What it names that the line does not say (a DID, a malformed document's detail) goes behind the ⓘ. */
  detail?: true;
}

const exact = (text: string, key: TranslationKey): Refusal => ({ match: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), key });

const AT = "(?<url>https:\\/\\/\\S+)";

const REFUSALS: readonly Refusal[] = [
  // The DID typed in Add's field (core did.ts parseDid, parseWeb).
  exact("A did:web domain has no percent-encoding, other than %3A before a port", "identities.refusal.webPercent"),
  exact("did:web: write the domain as ASCII (punycode for international names)", "identities.refusal.webAscii"),
  exact("did:web: that port is not valid", "identities.refusal.webPort"),
  exact("did:web: at most 8 path segments", "identities.refusal.webSegments"),
  exact("did:web: each path segment is letters, digits, dots, dashes, underscores or tildes", "identities.refusal.webSegment"),
  exact("Not a did:web", "identities.refusal.notWeb"),
  exact("This is not a valid did:dht", "identities.refusal.dhtInvalid"),
  exact("The DID is not in canonical form", "identities.refusal.notCanonical"),
  exact("Only a did:web can publish its proof", "errors.proof.didWebOnly"),
  // Its keys and document (core did.ts, didDht.ts; browser proofs/did.ts).
  exact("Not base64url", "identities.refusal.notBase64url"),
  exact("Not canonical base64url", "identities.refusal.notCanonicalBase64url"),
  exact("That Ed25519 key is a point of small order, which no secret key goes with", "identities.refusal.smallOrder"),
  { match: /^That (?<curve>\S+) key is not a valid point$/, key: "identities.refusal.keyNotPoint" },
  exact("That JWK is not an object", "identities.refusal.jwkNotObject"),
  exact("JWK coordinates are 32 bytes", "identities.refusal.jwkCoordinates"),
  { match: /^That (?<curve>\S+) JWK is malformed$/, key: "identities.refusal.jwkMalformed" },
  exact("The DID document is not a JSON object", "identities.refusal.documentNotObject"),
  exact("The DID document has no id", "identities.refusal.documentNoId"),
  { match: /^The DID document is for another DID \([\s\S]*\)$/, key: "identities.refusal.documentOtherDid", detail: true },
  { match: /^The DID document's (?<name>\w+) is not a list$/, key: "identities.refusal.documentNotList" },
  { match: /^The did:dht document is malformed: [\s\S]+$/, key: "identities.refusal.dhtMalformed", detail: true },
  exact("The did:dht record is not signed by the DID's key", "identities.refusal.dhtUnsigned"),
  exact("No document is published for this did:dht", "identities.refusal.dhtNotFound"),
  { match: new RegExp(`^${AT} is too large$`), key: "identities.refusal.urlTooLarge" },
  { match: new RegExp(`^${AT} is not text$`), key: "identities.refusal.urlNotText" },
  // The signature pasted in Add's signature step (core did.ts parseJws, verifyJws, verifyDidSignature, readSignature).
  exact("Paste the signature", "identities.refusal.paste"),
  exact("Paste the JWS alone: its header names the key (kid)", "identities.refusal.pasteJwsAlone"),
  exact("That is too long for a signature", "identities.refusal.signatureTooLong"),
  exact("That is not a signature: paste a JWS, or a signature in hex or base64", "identities.refusal.notSignature"),
  exact("That is not a compact JWS", "identities.refusal.notJws"),
  exact("A compact JWS has three parts separated by dots", "identities.refusal.jwsParts"),
  exact("The JWS header is not base64url JSON", "identities.refusal.jwsHeaderNotJson"),
  exact("The JWS header is not a JSON object", "identities.refusal.jwsHeaderNotObject"),
  exact("The JWS uses another algorithm: Ghostly checks EdDSA, ES256K and ES256", "identities.refusal.jwsAlgOther"),
  exact("The JWS uses no algorithm: Ghostly checks EdDSA, ES256K and ES256", "identities.refusal.jwsAlgNone"),
  exact("The JWS kid is not a key id", "identities.refusal.jwsKid"),
  exact("The JWS b64 header is not true or false", "identities.refusal.jwsB64"),
  exact("The JWS requires an extension Ghostly does not know (crit)", "identities.refusal.jwsCrit"),
  exact("A JWS with b64 false must list it in crit", "identities.refusal.jwsB64Crit"),
  exact("A JWS with b64 false must be detached (header..signature)", "identities.refusal.jwsB64Detached"),
  exact("The JWS signature is not base64url", "identities.refusal.jwsSignatureEncoding"),
  exact("The JWS payload is not base64url", "identities.refusal.jwsPayloadEncoding"),
  { match: /^A (?<alg>\S+) signature is 64 bytes$/, key: "identities.refusal.jwsSignatureLength" },
  { match: /^The JWS names a key that is not a key of \S+$/, key: "identities.refusal.jwsKeyOtherDid", detail: true },
  exact("The DID document does not list the key the JWS names", "identities.refusal.jwsKeyUnknown"),
  { match: /^The key the JWS names is not a (?<curve>\S+) key: the JWS says (?<alg>\S+)$/, key: "identities.refusal.jwsKeyCurve" },
  { match: /^The DID document lists no (?<curve>\S+) key for (?<alg>\S+)$/, key: "identities.refusal.noCurveKey" },
  exact("Signed by a key the DID document does not list under authentication or assertionMethod", "identities.refusal.keyNotListed"),
  exact("The JWS carries another text: sign exactly the statement shown", "identities.refusal.jwsOtherText"),
  exact("The JWS signature does not match: sign exactly the statement shown, with a key of this DID", "identities.refusal.jwsMismatch"),
  { match: /^The proof names a key that is not a key of \S+$/, key: "identities.refusal.proofKeyOtherDid", detail: true },
  exact("The DID document does not list the key the proof names", "identities.refusal.proofKeyUnknown"),
  exact("A signature is 64 bytes (or DER, for ECDSA)", "identities.refusal.signatureLength"),
  exact("The signature does not match: sign exactly the statement shown, with a key of this DID", "identities.refusal.signatureMismatch"),
  // A proof checked again (core did.ts proofIdOf; browser providers/did.ts verify).
  exact("Invalid proof id", "identities.refusal.proofId"),
  exact("Statement is not signable as plain text", "identities.refusal.statementNotPlain"),
  exact("Signed by another key than the proof names", "identities.refusal.otherKey"),
  { match: new RegExp(`^${AT} is not the statement of this proof$`), key: "identities.refusal.fileOtherStatement" },
];

/** A did:web whose domain is refused (core did.ts parseWeb: "did:web: " and domainProofs.ts normalizeDomain's reason). */
const WEB_DOMAIN = /^did:web: (?<reason>[\s\S]+)$/;

/**
 * `raw`, a DID refusal, in `t`'s language: a title, and the English behind the ⓘ when the title leaves out what it
 * names. Null when it is none of them (lib/problemText.ts reads it on).
 */
export function didRefusal(raw: string, t: Translate): { title: string; detail?: string } | null {
  for (const refusal of REFUSALS) {
    const found = raw.match(refusal.match);
    if (!found) continue;
    return { title: t(refusal.key, { ...found.groups }), ...(refusal.detail && { detail: raw }) };
  }
  const reason = raw.match(WEB_DOMAIN)?.groups?.reason;
  const said = reason !== undefined ? knownErrorText(reason, t) : null;
  return said ? { title: said, detail: raw } : null;
}
