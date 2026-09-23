import type { IdentityStatement } from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider, SignerInstructions } from "../contract";
import {
  KEYSERVER, PgpProofError, assertSignableStatement, fetchKeyFromKeyserver, formatFingerprint, keyserverVerifiedEmails, parsePgpEvidence,
  preparePgpEvidence, splitPgpPaste, verifyPgpEvidence, type PgpEvidence,
} from "../openpgp";

/**
 * OpenPGP keys, signed with the person's own gpg — a YubiKey or another OpenPGP card works unchanged,
 * since gpg drives it. The subject is the primary key's fingerprint. See docs/wisps/3xx-openpgp.md.
 */

/** A v4 (40 hex) or v6 (64 hex) fingerprint, as gpg prints it or not: spaces and 0x are dropped. */
export function normalizeFingerprint(input: string): string {
  const value = input.trim().replace(/^0x/i, "").replace(/\s+/g, "").toUpperCase();
  if (/^[A-F0-9]{40}$/.test(value) || /^[A-F0-9]{64}$/.test(value)) return value;
  if (/^[A-F0-9]{8}$|^[A-F0-9]{16}$/.test(value)) throw new PgpProofError("Use the full fingerprint, not a key ID: gpg --fingerprint shows it.");
  throw new PgpProofError("Enter your key's fingerprint: 40 hex characters (gpg --fingerprint).");
}

/** The user ID is its holder's own words: shown with that caveat, never as a checked name. */
const USER_ID_SOURCE = "User ID on the key, written by its holder: not proof that the name or email is theirs";
const KEYSERVER_SOURCE = "Email confirmed to keys.openpgp.org by its owner: the keyserver's check, not Ghostly's";

function steps(statement: IdentityStatement, exportKey: boolean): SignerInstructions {
  assertSignableStatement(statement.text);
  // The statement is one line of space-separated fields with no quote in it, so it is safe in single quotes.
  if (statement.text.includes("'")) throw new PgpProofError("Statement is not signable as plain text");
  const fpr = normalizeFingerprint(statement.binding.subject);
  const sign = `gpg --local-user ${fpr} --clearsign --output - ghostly-identity.txt`;
  return {
    steps: [
      { text: "Save the statement to a file (it is one line, with no newline at the end):", copy: `printf '%s' '${statement.text}' > ghostly-identity.txt` },
      exportKey
        ? { text: "Sign it and export your public key, then copy everything this prints:", copy: `${sign} && gpg --armor --export --export-options export-minimal ${fpr}` }
        : { text: "Sign it, then copy everything this prints:", copy: sign },
      { text: "On a YubiKey or another OpenPGP card, gpg asks for the card's PIN, and for a touch if the card requires one. Without a shell, save the statement below in a text file and sign that file.", copy: statement.text },
    ],
    paste: { label: exportKey ? "Signed statement and public key" : "Signed statement", placeholder: "-----BEGIN PGP SIGNED MESSAGE-----", multiline: true },
  };
}

async function evidenceFrom(statement: IdentityStatement, signature: string, publicKey: string): Promise<PgpEvidence> {
  const { evidence } = await preparePgpEvidence({ statement: statement.text, signature, publicKey },
    { expectedFingerprint: normalizeFingerprint(statement.binding.subject), signedAfter: statement.binding.issuedAt });
  return evidence;
}

const gpg: ExternalToolSigner<PgpEvidence> = {
  id: "gpg", kind: "external-tool", label: "gpg",
  description: "Sign with gpg and paste what it prints, public key included. Nothing is looked up.",
  instructions: statement => steps(statement, true),
  async parse(pasted, statement) {
    const { signature, publicKey } = splitPgpPaste(pasted);
    if (!publicKey) throw new PgpProofError("Paste your public key too: the second command prints it (-----BEGIN PGP PUBLIC KEY BLOCK-----).");
    return evidenceFrom(statement, signature, publicKey);
  },
};

const gpgKeyserver: ExternalToolSigner<PgpEvidence> = {
  id: "gpg-keys-openpgp-org", kind: "external-tool", label: "gpg, key from keys.openpgp.org",
  description: "Sign with gpg and paste the signature; Ghostly then fetches your public key from keys.openpgp.org, which learns which key was looked up.",
  instructions: statement => steps(statement, false),
  async parse(pasted, statement) {
    const { signature, publicKey } = splitPgpPaste(pasted);
    // Only here, on the person's choice of this signer, is the keyserver contacted.
    const key = publicKey ?? (await fetchKeyFromKeyserver(statement.binding.subject)).armored;
    return evidenceFrom(statement, signature, key);
  },
};

export const openpgp: IdentityProofProvider<PgpEvidence> = {
  id: "openpgp",
  label: "OpenPGP key",
  category: "self-custodied",
  description: "Proves you hold an OpenPGP key: sign the statement with gpg (a YubiKey works too) and paste the result.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Key fingerprint", placeholder: "40 hex characters, from gpg --fingerprint",
    help: "The primary key's full fingerprint. Holding a key does not prove the names or emails in its user IDs.",
    normalize: normalizeFingerprint,
    short: fpr => `…${formatFingerprint(fpr.slice(-16))}`,
  },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: `Nothing: the signature is checked on this device. ${KEYSERVER.replace("https://", "")} is contacted only if you choose it for your key, or ask it to confirm emails.`,
  signers: [gpg, gpgKeyserver],
  lookupLabel: "Check emails with keys.openpgp.org",
  parseEvidence: raw => parsePgpEvidence(raw),
  async verify(statement, evidence, ctx) {
    ctx.signal.throwIfAborted();
    const { binding } = statement;
    const verified = await verifyPgpEvidence(evidence, statement.text, { now: ctx.now, signedAfter: binding.issuedAt, expectedFingerprint: normalizeFingerprint(binding.subject) });
    const subkey = verified.signingFingerprint !== verified.fingerprint;
    const [userId] = verified.userIds;
    return {
      subject: verified.fingerprint,
      source: `OpenPGP signature (${verified.algorithm}${subkey ? " signing subkey" : ""}, v${verified.version} key)`,
      ...(verified.expiresAt !== null && verified.expiresAt < binding.expiresAt ? { expiresAt: verified.expiresAt } : {}),
      ...(userId ? { display: { name: userId, source: USER_ID_SOURCE, fetchedAt: ctx.now } } : {}),
    };
  },
  /** On request only: which emails on this key keys.openpgp.org confirmed, and whether it holds a revocation. */
  async lookupDisplay(subject, { signal }) {
    const fpr = normalizeFingerprint(subject);
    const found = await fetchKeyFromKeyserver(fpr, { signal });
    const emails = await keyserverVerifiedEmails(found.armored, fpr);
    if (!emails.length) return undefined;
    return { name: emails[0], url: `${KEYSERVER}/search?q=${fpr}`, source: KEYSERVER_SOURCE, fetchedAt: found.fetchedAt };
  },
};
