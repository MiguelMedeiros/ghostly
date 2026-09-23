import { fromBase64Url, toBase64Url, utf8Encode } from '@ghostly/core';
import type * as OpenPGP from 'openpgp';

/**
 * OpenPGP identity proofs (RFC 9580, and the RFC 4880 v4 keys people actually have).
 *
 * The person signs a Ghostly statement once — the binding by which their
 * OpenPGP key authorizes a Ghostly proof key (see PROOFS.md); each chat
 * then gets a presentation the app signs itself. They sign with their own tooling —
 * `gpg --clearsign`, `gpg --detach-sign --armor`, a YubiKey or another OpenPGP
 * card behind gpg — and pastes the result with their public key. No secret key
 * ever enters Ghostly: a pasted private key is refused before it is parsed.
 *
 * What is shared with a contact is small and self-contained: one signature
 * packet and a minimal copy of the public key (the primary key, its user IDs
 * with their self-signatures, the subkey that signed). The contact verifies it
 * locally with the statement their own app builds; nothing is fetched.
 *
 * A key's user IDs are claims its holder wrote. Possession of the key proves
 * control of the key, not that a name or an email in a user ID belongs to the
 * person — the UI must say so wherever user IDs are shown.
 *
 * OpenPGP.js is loaded lazily (the "lightweight" build: ~233 KB minified,
 * ~64 KB gzipped, plus a ~46 KB curve chunk only for ECDSA keys), so nobody
 * pays for it until an OpenPGP proof is opened.
 */

export const PGP_SCHEME = 'openpgp/1';

/** Strict size limits. Pasted input is the person's own; shared input comes from a peer. */
export const PGP_LIMITS = {
  /** A clearsigned statement or an armored detached signature. RSA-4096 with the statement is ~1.5 KB. */
  pastedSignature: 16 * 1024,
  /** An armored public key as exported, before it is minimized. Flooded keys are refused, not trimmed. */
  pastedKey: 256 * 1024,
  /** One signature packet, binary. RSA-4096 with the usual subpackets is ~600 bytes. */
  sharedSignature: 1536,
  /** The minimal key, binary. Both fit, base64url, in the contract's 16 KiB of evidence JSON. */
  sharedKey: 9 * 1024,
  /** User IDs kept in the minimal key and shown. */
  userIds: 16,
  /** Bytes per user ID. */
  userIdLength: 256,
  /** A keyserver response. */
  keyserverResponse: 256 * 1024,
} as const;

/** Clock difference tolerated between the signer's machine and the verifier. */
export const PGP_CLOCK_SKEW = 300;

export interface PgpEvidence {
  scheme: typeof PGP_SCHEME;
  /** base64url of the minimal transferable public key (binary packets). */
  key: string;
  /** base64url of exactly one signature packet over the statement. */
  signature: string;
}

export interface PgpKeyInfo {
  /** Primary key fingerprint, uppercase hex (40 characters for v4, 64 for v6). */
  fingerprint: string;
  /** The key that signs: the primary key or a signing subkey. */
  signingFingerprint: string;
  version: 4 | 6;
  /** "Ed25519", "RSA 3072", "ECDSA P-256", … for the signing key. */
  algorithm: string;
  createdAt: number;
  /** Seconds, or null when the key does not expire. */
  expiresAt: number | null;
  /** Self-certified, unrevoked user IDs: claims by the key holder, not verified facts. */
  userIds: string[];
}

export interface PgpVerified extends PgpKeyInfo {
  /** Signature creation time, seconds. */
  signedAt: number;
}

export interface PgpVerifyOptions {
  /** Verification time, seconds. The key and its signing subkey must be valid now. */
  now?: number;
  /** Refuse signatures made before this time (seconds), e.g. the start of the binding's validity. */
  signedAfter?: number;
  /** The primary key fingerprint the statement names: any other key is refused, even with a valid signature. */
  expectedFingerprint?: string;
}

type Pgp = typeof OpenPGP;
let loading: Promise<Pgp> | undefined;
/** The only place OpenPGP.js is imported: a separate chunk, fetched on first use. */
export function loadOpenPgp(): Promise<Pgp> {
  loading ??= import('openpgp/lightweight').then(m => m as unknown as Pgp).catch(e => { loading = undefined; throw e; });
  return loading;
}

function config(pgp: Pgp): OpenPGP.PartialConfig {
  const { hash, publicKey, curve } = pgp.enums;
  return {
    minRSABits: 2048,
    maxUserIDLength: PGP_LIMITS.userIdLength,
    enableParsingV5Entities: false,
    ignoreUnsupportedPackets: true,
    ignoreMalformedPackets: false,
    // Self-signatures from older keys may still use SHA-1; the proof signature may not (below).
    rejectHashAlgorithms: new Set([hash.md5, hash.ripemd]),
    rejectMessageHashAlgorithms: new Set([hash.md5, hash.ripemd, hash.sha1]),
    rejectPublicKeyAlgorithms: new Set([publicKey.elgamal, publicKey.dsa]),
    rejectCurves: new Set([curve.secp256k1]),
  };
}

/** The allowlist, checked on the primary key and on the key that signs. */
function allowedAlgorithm(packet: OpenPGP.PublicKeyPacket | OpenPGP.SecretKeyPacket | OpenPGP.PublicSubkeyPacket | OpenPGP.SecretSubkeyPacket, signing: boolean): string {
  const { algorithm, bits, curve } = packet.getAlgorithmInfo();
  const names: Record<string, string> = { nistP256: 'P-256', nistP384: 'P-384', nistP521: 'P-521',
    brainpoolP256r1: 'brainpoolP256r1', brainpoolP384r1: 'brainpoolP384r1', brainpoolP512r1: 'brainpoolP512r1' };
  if ((algorithm === 'rsaEncryptSign' || (algorithm === 'rsaSign' && signing)) && bits && bits >= 2048) return `RSA ${bits}`;
  if (algorithm === 'ed25519' || (algorithm === 'eddsaLegacy' && curve === 'ed25519Legacy')) return 'Ed25519';
  if (algorithm === 'ed448') return 'Ed448';
  if (algorithm === 'ecdsa' && curve && names[curve]) return `ECDSA ${names[curve]}`;
  const shown = algorithm.startsWith('rsa') ? `RSA ${bits ?? '?'}` : curve ? `${algorithm} ${curve}` : algorithm;
  throw new PgpProofError(`This key uses ${shown}, which Ghostly does not accept. Use Ed25519, ECDSA (P-256, P-384, P-521, brainpool) or RSA with at least 2048 bits.`);
}
const ALLOWED_HASHES = new Set([8, 9, 10, 11, 12, 14]); // SHA-256, -384, -512, -224, SHA3-256, SHA3-512

export class PgpProofError extends Error { override name = 'PgpProofError'; }

/** Armored blocks in pasted text; more BEGIN lines than any real paste has are refused before the regex scans. */
function armorBlocks(text: string): RegExpExecArray[] {
  if ((text.match(/-----BEGIN PGP /g) ?? []).length > 4) throw new PgpProofError('Paste only what gpg printed: one signature and your public key.');
  return [...text.matchAll(ARMOR)];
}
// A clearsigned message has no END line of its own: it ends with its signature block.
const ARMOR = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----|-----BEGIN PGP ([A-Z ,/0-9]+)-----[\s\S]*?-----END PGP \1-----/g;
/** The single armored block in pasted text (terminal output may surround it). */
function armoredBlock(text: string, what: 'key' | 'signature'): { type: string; block: string } {
  if (/PRIVATE KEY BLOCK/.test(text))
    throw new PgpProofError('This is a PRIVATE key. Never paste it anywhere: Ghostly only needs your public key (gpg --armor --export).');
  const blocks = armorBlocks(text);
  if (blocks.length === 0) throw new PgpProofError(what === 'key' ? 'Paste an armored public key: it starts with -----BEGIN PGP PUBLIC KEY BLOCK-----.' : 'Paste the whole signed text: it starts with -----BEGIN PGP SIGNED MESSAGE----- (or -----BEGIN PGP SIGNATURE----- for a detached signature).');
  if (blocks.length > 1) throw new PgpProofError(`Paste only one ${what === 'key' ? 'public key' : 'signature'}.`);
  return { type: blocks[0][1] ?? 'SIGNED MESSAGE', block: blocks[0][0] };
}

function secondsOf(date: Date | number | null | typeof Infinity): number | null {
  if (date === null || date === Infinity) return null;
  return Math.floor((date instanceof Date ? date.getTime() : date) / 1000);
}
const hexOf = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Clearsigned text as it is hashed: trailing whitespace dropped, no final newline. */
export function canonicalStatement(statement: string): string {
  return statement.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
}

/**
 * One paste holding what gpg printed: the signed statement (clearsigned, or a detached signature) and,
 * optionally, the public key. Anything around the blocks (prompts, blank lines) is ignored.
 */
export function splitPgpPaste(pasted: string): { signature: string; publicKey?: string } {
  if (typeof pasted !== 'string' || pasted.length > PGP_LIMITS.pastedKey + PGP_LIMITS.pastedSignature) throw new PgpProofError('This is too large. Paste only what gpg printed.');
  if (/PRIVATE KEY BLOCK/.test(pasted)) throw new PgpProofError('This is a PRIVATE key. Never paste it anywhere: Ghostly only needs your public key (gpg --armor --export).');
  const blocks = armorBlocks(pasted).map(m => ({ type: m[1] ?? 'SIGNED MESSAGE', block: m[0] }));
  const keys = blocks.filter(b => b.type === 'PUBLIC KEY BLOCK'), others = blocks.filter(b => b.type !== 'PUBLIC KEY BLOCK');
  if (keys.length > 1) throw new PgpProofError('Paste only one public key.');
  if (others.length === 0) throw new PgpProofError('Paste the signed statement too: it starts with -----BEGIN PGP SIGNED MESSAGE-----.');
  if (others.length > 1) throw new PgpProofError('Paste only one signature.');
  return { signature: others[0].block, publicKey: keys[0]?.block };
}

/** Refuses a statement that `gpg --clearsign` would alter (dash-escaping, trailing spaces) or that is not plain text. */
export function assertSignableStatement(statement: string): void {
  if (!statement || statement.length > 4096 || statement !== canonicalStatement(statement) || /^-/m.test(statement) || /[^\x20-\x7e\n]/.test(statement))
    throw new PgpProofError('Statement is not signable as plain text');
}

/** Why a key or a subkey is not usable now, in words the person can act on. */
async function explainInvalidKey(key: OpenPGP.PublicKey, keyId: OpenPGP.KeyID | undefined, at: Date, cfg: OpenPGP.PartialConfig, when: 'now' | 'signing'): Promise<never> {
  const past = when === 'signing' ? ' when it signed' : '';
  if (await key.isRevoked(undefined, undefined, at, cfg as OpenPGP.Config).catch(() => false))
    throw new PgpProofError(`This key has been revoked${past}. A revoked key proves nothing.`);
  try { await key.verifyPrimaryKey(at, undefined, cfg as OpenPGP.Config); }
  catch (e) {
    const expiry = await key.getExpirationTime(undefined, cfg as OpenPGP.Config).catch(() => null);
    if (expiry instanceof Date && expiry <= at) throw new PgpProofError(`This key expired on ${expiry.toISOString().slice(0, 10)}${past}. Extend its expiry (gpg --quick-set-expire) and export it again.`);
    throw new PgpProofError(`This key is not valid${past}: ${message(e)}`);
  }
  const sub = keyId ? key.getSubkeys(keyId)[0] : undefined;
  if (sub) {
    if (sub.revocationSignatures.length && await sub.verify(at, cfg as OpenPGP.Config).then(() => false, e => /revoked/i.test(message(e))))
      throw new PgpProofError(`The subkey that signed (${sub.getFingerprint().toUpperCase()}) has been revoked${past}.`);
    const expiry = await sub.getExpirationTime(at, cfg as OpenPGP.Config).catch(() => null);
    if (expiry instanceof Date && expiry <= at) throw new PgpProofError(`The subkey that signed expired on ${expiry.toISOString().slice(0, 10)}${past}.`);
    throw new PgpProofError(`The subkey that signed is not a valid signing subkey${past}.`);
  }
  throw new PgpProofError(`The key that signed is not a valid signing key${past}.`);
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Parses exactly one public key; refuses private keys, v3/v5 keys and key rings. */
async function readOneKey(pgp: Pgp, input: { armored: string } | { binary: Uint8Array }): Promise<OpenPGP.PublicKey> {
  const cfg = config(pgp);
  let keys: OpenPGP.Key[];
  try {
    keys = 'armored' in input ? await pgp.readKeys({ armoredKeys: input.armored, config: cfg }) : await pgp.readKeys({ binaryKeys: input.binary, config: cfg });
  } catch (e) { throw new PgpProofError(`Could not read this public key: ${message(e)}`); }
  if (keys.length !== 1) throw new PgpProofError('Paste one public key, not a key ring.');
  const [key] = keys;
  if (key.isPrivate()) throw new PgpProofError('This is a PRIVATE key. Ghostly only needs your public key (gpg --armor --export).');
  const version = key.keyPacket.version;
  if (version !== 4 && version !== 6) throw new PgpProofError(`OpenPGP v${version} keys are not accepted; use a v4 (RFC 4880) or v6 (RFC 9580) key.`);
  return key as OpenPGP.PublicKey;
}

/** Valid, unrevoked, self-certified user IDs at `at`. */
async function validUserIds(key: OpenPGP.PublicKey, at: Date, cfg: OpenPGP.PartialConfig): Promise<OpenPGP.User[]> {
  const valid: OpenPGP.User[] = [];
  for (const user of key.users) {
    if (!user.userID || valid.length >= PGP_LIMITS.userIds) continue;
    if (await user.verify(at, cfg as OpenPGP.Config).then(() => true, () => false)) valid.push(user);
  }
  return valid;
}

/**
 * The transferable key a contact receives: primary key and its direct/revocation
 * signatures, valid user IDs with self-certifications only (third-party
 * certifications and photos dropped), and the one subkey that signed.
 */
async function minimalKey(pgp: Pgp, key: OpenPGP.PublicKey, signer: OpenPGP.PublicKey | OpenPGP.Subkey, at: Date, cfg: OpenPGP.PartialConfig): Promise<Uint8Array> {
  const packets = new pgp.PacketList<OpenPGP.AnyPacket>();
  packets.push(key.keyPacket, ...key.revocationSignatures);
  // Direct-key self-signatures carry v6 key properties; OpenPGP.js keeps them here.
  const direct = (key as unknown as { directSignatures?: OpenPGP.SignaturePacket[] }).directSignatures ?? [];
  packets.push(...direct);
  for (const user of await validUserIds(key, at, cfg)) packets.push(user.userID!, ...user.selfCertifications, ...user.revocationSignatures);
  if (signer !== key) {
    const sub = signer as OpenPGP.Subkey;
    packets.push(sub.keyPacket, ...sub.bindingSignatures, ...sub.revocationSignatures);
  }
  const bytes = new pgp.PublicKey(packets).write();
  if (bytes.length > PGP_LIMITS.sharedKey) throw new PgpProofError('This key is too large to share, even without third-party certifications. Remove old user IDs or use a smaller key.');
  return bytes;
}

async function keyInfo(key: OpenPGP.PublicKey, signer: OpenPGP.PublicKey | OpenPGP.Subkey, algorithm: string, at: Date, cfg: OpenPGP.PartialConfig): Promise<PgpKeyInfo> {
  const expiry = await key.getExpirationTime(undefined, cfg as OpenPGP.Config).catch(() => null);
  const subExpiry = signer !== key ? await (signer as OpenPGP.Subkey).getExpirationTime(at, cfg as OpenPGP.Config).catch(() => null) : null;
  const expires = [secondsOf(expiry), secondsOf(subExpiry)].filter((x): x is number => x !== null);
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    signingFingerprint: signer.getFingerprint().toUpperCase(),
    version: key.keyPacket.version as 4 | 6,
    algorithm,
    createdAt: secondsOf(key.getCreationTime())!,
    expiresAt: expires.length ? Math.min(...expires) : null,
    userIds: (await validUserIds(key, at, cfg)).map(u => u.userID!.userID),
  };
}

/** What a pasted public key is, before anything is signed: fingerprint and user IDs to show. */
export async function readPgpPublicKey(armored: string, options: { now?: number } = {}): Promise<PgpKeyInfo> {
  if (typeof armored !== 'string' || armored.length > PGP_LIMITS.pastedKey) throw new PgpProofError('This public key is too large. Export it with --export-options export-minimal.');
  const { type, block } = armoredBlock(armored, 'key');
  if (type !== 'PUBLIC KEY BLOCK') throw new PgpProofError('Paste a public key block (gpg --armor --export).');
  const pgp = await loadOpenPgp();
  const cfg = config(pgp);
  const key = await readOneKey(pgp, { armored: block });
  const at = new Date((options.now ?? nowSeconds()) * 1000);
  allowedAlgorithm(key.keyPacket, false);
  let signer: OpenPGP.PublicKey | OpenPGP.Subkey;
  try { signer = await key.getSigningKey(undefined, at, undefined, cfg as OpenPGP.Config) as OpenPGP.PublicKey | OpenPGP.Subkey; }
  catch { return explainInvalidKey(key, undefined, at, cfg, 'now'); }
  return keyInfo(key, signer, allowedAlgorithm(signer.keyPacket, true), at, cfg);
}

async function readSignaturePacket(pgp: Pgp, input: { armored: string } | { binary: Uint8Array }): Promise<OpenPGP.SignaturePacket> {
  let sig: OpenPGP.Signature;
  try {
    sig = 'armored' in input ? await pgp.readSignature({ armoredSignature: input.armored, config: config(pgp) }) : await pgp.readSignature({ binarySignature: input.binary, config: config(pgp) });
  } catch (e) { throw new PgpProofError(`Could not read this signature: ${message(e)}`); }
  const packets = sig.packets.filterByTag(pgp.enums.packet.signature) as unknown as OpenPGP.SignaturePacket[];
  if (sig.packets.length !== 1 || packets.length !== 1) throw new PgpProofError('Sign with one key only: this signature has several signers.');
  return packets[0];
}

/**
 * The core check, shared by the person (on paste) and the contact (on receipt):
 * one signature over the statement, by a key or signing subkey of `key` that is
 * valid both when it signed and now, with allowed algorithms and hash.
 */
async function verifyPacket(pgp: Pgp, key: OpenPGP.PublicKey, sig: OpenPGP.SignaturePacket, statement: string, options: PgpVerifyOptions): Promise<{ info: PgpVerified; signer: OpenPGP.PublicKey | OpenPGP.Subkey }> {
  const cfg = config(pgp);
  const now = options.now ?? nowSeconds();
  const at = new Date(now * 1000);
  const { signature } = pgp.enums;
  if (sig.signatureType !== signature.text && sig.signatureType !== signature.binary) throw new PgpProofError('This is not a signature over a text or a file.');
  if (sig.hashAlgorithm === null || !ALLOWED_HASHES.has(sig.hashAlgorithm)) throw new PgpProofError('This signature uses a weak hash (SHA-1 or older). Sign again with gpg\'s default (SHA-256 or stronger): --digest-algo SHA256.');
  if (!sig.created) throw new PgpProofError('This signature has no creation time.');
  const signedAt = secondsOf(sig.created)!;
  if (signedAt > now + PGP_CLOCK_SKEW) throw new PgpProofError('This signature is dated in the future. Check the clock of the machine that signed.');
  if (options.expectedFingerprint !== undefined && key.getFingerprint().toUpperCase() !== options.expectedFingerprint.toUpperCase())
    throw new PgpProofError('This key is not the one the statement names.');
  const issuer = key.getKeys(sig.issuerKeyID)[0];
  if (!issuer) throw new PgpProofError(`This signature was made by another key (${sig.issuerKeyID.toHex().toUpperCase()}), not the public key given.`);
  if (sig.issuerFingerprint && hexOf(sig.issuerFingerprint) !== issuer.getFingerprint().toUpperCase())
    throw new PgpProofError('This signature was made by another key, not the public key given.');
  allowedAlgorithm(key.keyPacket, false);
  // Valid now (not expired, not revoked, signing-capable with its back-signature)…
  let signer: OpenPGP.PublicKey | OpenPGP.Subkey;
  try { signer = await key.getSigningKey(sig.issuerKeyID, at, undefined, cfg as OpenPGP.Config) as OpenPGP.PublicKey | OpenPGP.Subkey; }
  catch { return explainInvalidKey(key, sig.issuerKeyID, at, cfg, 'now'); }
  const algorithm = allowedAlgorithm(signer.keyPacket, true);
  // …and when it signed.
  const created = new Date(Math.min(signedAt, now) * 1000);
  try { await key.getSigningKey(sig.issuerKeyID, created, undefined, cfg as OpenPGP.Config); }
  catch { return explainInvalidKey(key, sig.issuerKeyID, created, cfg, 'signing'); }
  // After the key checks, so an expired or revoked key is reported as such.
  if (options.signedAfter !== undefined && signedAt < options.signedAfter - PGP_CLOCK_SKEW) throw new PgpProofError('This signature is older than the statement it should sign.');
  // A detached signature over a file holds its final newline; clearsigned text does not.
  const text = canonicalStatement(statement);
  const packets = new pgp.PacketList<OpenPGP.AnyPacket>(); packets.push(sig);
  const detached = new pgp.Signature(packets as OpenPGP.PacketList<OpenPGP.SignaturePacket>);
  let verified = false;
  for (const candidate of [text, `${text}\n`, `${text}\r\n`]) {
    const message = await pgp.createMessage({ binary: utf8Encode(candidate) });
    const result = await pgp.verify({ message, signature: detached, verificationKeys: key, date: new Date(Math.max(now, signedAt) * 1000), config: cfg });
    if (result.signatures.length === 1 && await result.signatures[0].verified.then(() => true, () => false)) { verified = true; break; }
  }
  if (!verified) throw new PgpProofError('This signature is not over the Ghostly statement (it signs other text, or it was changed).');
  return { info: { ...await keyInfo(key, signer, algorithm, at, cfg), signedAt }, signer };
}

/**
 * The person's side: checks what they pasted against the statement and
 * produces the evidence to share. Either a clearsigned statement or an
 * armored detached signature is accepted.
 */
export async function preparePgpEvidence(input: { statement: string; signature: string; publicKey: string }, options: PgpVerifyOptions = {}): Promise<{ evidence: PgpEvidence; verified: PgpVerified }> {
  if (typeof input.signature !== 'string' || input.signature.length > PGP_LIMITS.pastedSignature) throw new PgpProofError('This signature is too large. Paste only the output of gpg --clearsign.');
  if (typeof input.publicKey !== 'string' || input.publicKey.length > PGP_LIMITS.pastedKey) throw new PgpProofError('This public key is too large. Export it with --export-options export-minimal.');
  const { type, block } = armoredBlock(input.signature, 'signature');
  const keyBlock = armoredBlock(input.publicKey, 'key');
  if (keyBlock.type !== 'PUBLIC KEY BLOCK') throw new PgpProofError('Paste a public key block (gpg --armor --export).');
  if (type === 'MESSAGE') throw new PgpProofError('This is a signed message (gpg --sign). Use gpg --clearsign, or --detach-sign --armor.');
  if (type === 'PUBLIC KEY BLOCK') throw new PgpProofError('This is a public key; paste it in the public key field and the signature here.');
  const pgp = await loadOpenPgp();
  const key = await readOneKey(pgp, { armored: keyBlock.block });
  let sig: OpenPGP.SignaturePacket;
  if (type === 'SIGNED MESSAGE') {
    let cleartext: OpenPGP.CleartextMessage;
    try { cleartext = await pgp.readCleartextMessage({ cleartextMessage: block, config: config(pgp) }); }
    catch (e) { throw new PgpProofError(`Could not read this signed text: ${message(e)}`); }
    if (canonicalStatement(cleartext.getText()) !== canonicalStatement(input.statement))
      throw new PgpProofError('This signs different text. Sign exactly the statement shown, without editing it.');
    // Typed as private in OpenPGP.js's declarations, public at runtime.
    const packets = (cleartext as unknown as { signature: OpenPGP.Signature }).signature.packets;
    if (packets.length !== 1 || !(packets[0] instanceof pgp.SignaturePacket)) throw new PgpProofError('Sign with one key only: this signature has several signers.');
    sig = packets[0];
  } else if (type === 'SIGNATURE') sig = await readSignaturePacket(pgp, { armored: block });
  else throw new PgpProofError('Paste the output of gpg --clearsign (or gpg --detach-sign --armor).');
  const { info, signer } = await verifyPacket(pgp, key, sig, input.statement, options);
  const single = new pgp.PacketList<OpenPGP.AnyPacket>(); single.push(sig);
  const signature = new pgp.Signature(single as OpenPGP.PacketList<OpenPGP.SignaturePacket>).write();
  if (signature.length > PGP_LIMITS.sharedSignature) throw new PgpProofError('This signature is too large to share.');
  const at = new Date((options.now ?? nowSeconds()) * 1000);
  const evidence: PgpEvidence = { scheme: PGP_SCHEME, key: toBase64Url(await minimalKey(pgp, key, signer, at, config(pgp))), signature: toBase64Url(signature) };
  return { evidence, verified: info };
}

const b64 = /^[A-Za-z0-9_-]+$/;
/** Untrusted evidence off the wire: exact shape, bounded, canonical base64url. Checked before any OpenPGP parsing. */
export function parsePgpEvidence(raw: unknown): PgpEvidence {
  const e = raw as PgpEvidence;
  if (!e || typeof e !== 'object' || Array.isArray(e) || e.scheme !== PGP_SCHEME || Object.keys(e).sort().join(',') !== 'key,scheme,signature' ||
    typeof e.key !== 'string' || typeof e.signature !== 'string' || !b64.test(e.key) || !b64.test(e.signature) ||
    e.key.length > Math.ceil(PGP_LIMITS.sharedKey * 4 / 3) || e.signature.length > Math.ceil(PGP_LIMITS.sharedSignature * 4 / 3))
    throw new PgpProofError('Invalid OpenPGP proof');
  let canonical: boolean;
  try { canonical = toBase64Url(fromBase64Url(e.key)) === e.key && toBase64Url(fromBase64Url(e.signature)) === e.signature; } catch { canonical = false; }
  if (!canonical) throw new PgpProofError('Invalid OpenPGP proof encoding');
  return { scheme: PGP_SCHEME, key: e.key, signature: e.signature };
}

/** The contact's side: verifies shared evidence against the statement their own app built. */
export async function verifyPgpEvidence(raw: PgpEvidence, statement: string, options: PgpVerifyOptions = {}): Promise<PgpVerified> {
  const evidence = parsePgpEvidence(raw);
  const keyBytes = fromBase64Url(evidence.key), sigBytes = fromBase64Url(evidence.signature);
  const pgp = await loadOpenPgp();
  const key = await readOneKey(pgp, { binary: keyBytes });
  const sig = await readSignaturePacket(pgp, { binary: sigBytes });
  return (await verifyPacket(pgp, key, sig, statement, options)).info;
}

/** Groups of four, as gpg prints fingerprints. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(.{4})/g, '$1 ').trim();
}

/** keys.openpgp.org publishes a user ID only after its owner confirms the email. */
export const KEYSERVER = 'https://keys.openpgp.org';
export interface KeyserverKey { armored: string; source: typeof KEYSERVER; fetchedAt: number }
/**
 * Fetches a public key from keys.openpgp.org. Only ever called when the person
 * asks for it, after the UI said this contacts that server.
 */
export async function fetchKeyFromKeyserver(query: string, options: { signal?: AbortSignal; fetch?: typeof fetch; now?: number } = {}): Promise<KeyserverKey> {
  const q = query.trim().replace(/\s+/g, '').replace(/^0x/i, '');
  let path: string;
  if (/^[A-Fa-f0-9]{40}$/.test(q) || /^[A-Fa-f0-9]{64}$/.test(q)) path = `/vks/v1/by-fingerprint/${q.toUpperCase()}`;
  else if (/^[^\s@<>]{1,64}@[^\s@<>]{1,190}$/.test(query.trim())) path = `/vks/v1/by-email/${encodeURIComponent(query.trim())}`;
  else throw new PgpProofError('Enter a full fingerprint (40 hex characters) or an email address.');
  const response = await (options.fetch ?? fetch)(`${KEYSERVER}${path}`, { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (response.status === 404) throw new PgpProofError('keys.openpgp.org has no key for this. Paste your public key instead.');
  if (!response.ok) throw new PgpProofError(`keys.openpgp.org answered ${response.status}. Paste your public key instead.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > PGP_LIMITS.keyserverResponse) throw new PgpProofError('The key from keys.openpgp.org is too large.');
  const armored = await response.text();
  if (armored.length > PGP_LIMITS.keyserverResponse) throw new PgpProofError('The key from keys.openpgp.org is too large.');
  return { armored, source: KEYSERVER, fetchedAt: options.now ?? nowSeconds() };
}

/**
 * Emails keys.openpgp.org vouches for on this key: it publishes a user ID only
 * once the email's owner confirmed it, so every user ID in its copy is one the
 * keyserver checked. That is the keyserver's check, and says nothing about a name.
 */
export async function keyserverVerifiedEmails(keyserverArmored: string, fingerprint: string, options: { now?: number } = {}): Promise<string[]> {
  const info = await readPgpPublicKey(keyserverArmored, options);
  if (info.fingerprint !== fingerprint.toUpperCase()) throw new PgpProofError('keys.openpgp.org returned a different key.');
  const emails = info.userIds.map(u => /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(u)?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(u) ? u : undefined));
  return [...new Set(emails.filter((e): e is string => !!e).map(e => e.toLowerCase()))];
}
