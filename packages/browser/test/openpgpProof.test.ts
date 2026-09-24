import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { fromBase64Url, toBase64Url } from '@ghostly/core';
import {
  PGP_LIMITS, assertSignableStatement, fetchKeyFromKeyserver, formatFingerprint, keyserverVerifiedEmails,
  preparePgpEvidence, readPgpPublicKey, verifyPgpEvidence, type PgpEvidence,
} from '../src/proofs/openpgp';
// covers: proofs.openpgp, proofs.openpgp.keyserver

// Vectors made by a real GnuPG: see test/vectors/openpgp/generate.sh. Test keys only.
const dir = new URL('./vectors/openpgp/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
const fpr = JSON.parse(read('fingerprints.json')) as Record<string, string>;
const statement = read('statement.txt');
const day = 86400;
const SIGNED = Date.UTC(2026, 1, 1) / 1000; // gpg's faked clock when it signed
const NOW = SIGNED + 28 * day; // 2026-03-01
const pasted = (sig: string, key: string, now = NOW) => preparePgpEvidence({ statement, signature: read(`${sig}.asc`), publicKey: read(`${key}.pub.asc`) }, { now });

describe('OpenPGP proof: what gpg makes is accepted', () => {
  it('a clearsigned statement from a YubiKey-style key (certify-only primary, Ed25519 signing subkey)', async () => {
    const { evidence, verified } = await pasted('alice-clearsign', 'alice');
    expect(verified).toMatchObject({ fingerprint: fpr.alice, signingFingerprint: fpr.aliceSigningSubkey, version: 4, algorithm: 'Ed25519',
      signedAt: SIGNED, expiresAt: null, userIds: ['Alice Test <alice@example.org>'] }); // the revoked user ID is not shown
    // The contact verifies what was shared, with the statement its own app builds.
    expect(await verifyPgpEvidence(evidence, statement, { now: NOW })).toEqual(verified);
  });
  it.each([['alice-detached', 'a detached signature over the file'], ['alice-detached-text', 'a --textmode detached signature']])('%s: %s', async name => {
    const { evidence } = await pasted(name, 'alice');
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW })).resolves.toMatchObject({ fingerprint: fpr.alice });
  });
  it.each([['bob', 'RSA 3072'], ['carol', 'ECDSA P-256'], ['dave', 'ECDSA brainpoolP256r1']])('%s: %s', async (name, algorithm) => {
    const { evidence, verified } = await pasted(`${name}-clearsign`, name);
    expect(verified).toMatchObject({ fingerprint: fpr[name], signingFingerprint: fpr[name], algorithm, userIds: [`${name[0].toUpperCase()}${name.slice(1)} Test <${name}@example.org>`] });
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW })).resolves.toMatchObject({ algorithm });
  });
  it('terminal output around the pasted blocks is ignored', async () => {
    const signature = `$ gpg --clearsign --output - ghostly-identity.txt\n${read('alice-clearsign.asc')}\n$ `;
    await expect(preparePgpEvidence({ statement, signature, publicKey: `\n${read('alice.pub.asc')}\n` }, { now: NOW })).resolves.toBeTruthy();
  });
  it('a key from RFC 9580 (v6, Ed25519) signed by OpenPGP.js, which GnuPG 2.2 cannot make', async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ name: 'Vera Six', email: 'vera@example.org' }], config: { v6Keys: true }, format: 'object' });
    const signature = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: statement }), signingKeys: privateKey });
    const { evidence, verified } = await preparePgpEvidence({ statement, signature, publicKey: publicKey.armor() });
    expect(verified).toMatchObject({ version: 6, algorithm: 'Ed25519', userIds: ['Vera Six <vera@example.org>'] });
    expect(verified.fingerprint).toMatch(/^[A-F0-9]{64}$/);
    await expect(verifyPgpEvidence(evidence, statement)).resolves.toMatchObject({ fingerprint: verified.fingerprint });
  });
});

describe('OpenPGP proof: refused', () => {
  const refuse = (sig: string, key: string, reason: RegExp, now = NOW) => expect(pasted(sig, key, now)).rejects.toThrow(reason);
  it('a signature on another statement', () => refuse('alice-other-statement', 'alice', /different text/));
  it('the statement edited after signing', async () => {
    const tampered = read('alice-clearsign.asc').replace('test vector', 'test vectoR');
    await expect(preparePgpEvidence({ statement: statement.replace('test vector', 'test vectoR'), signature: tampered, publicKey: read('alice.pub.asc') }, { now: NOW })).rejects.toThrow(/not over the Ghostly statement/);
  });
  it('a signature by another key than the one given', () => refuse('bob-clearsign', 'alice', /another key/));
  it('a key that expired (and the same signature while it was valid is fine)', async () => {
    await refuse('expired-clearsign', 'expired', /expired on 2026-06-01/, Date.UTC(2026, 6, 1) / 1000);
    await expect(pasted('expired-clearsign', 'expired')).resolves.toMatchObject({ verified: { expiresAt: Date.UTC(2026, 5, 1, 12) / 1000 } });
  });
  it('a revoked key, even for what it signed before (a hard revocation); the copy from before verifies', async () => {
    await refuse('revoked-clearsign', 'revoked', /revoked/);
    await refuse('revoked-clearsign', 'revoked', /revoked/, SIGNED);
    await expect(pasted('revoked-clearsign', 'revoked-unrevoked')).resolves.toBeTruthy();
  });
  it('a signing subkey retired since it signed (a soft revocation: valid until then)', async () => {
    await refuse('subkey-revoked-clearsign', 'subkey-revoked', /subkey that signed .* revoked/);
    await expect(pasted('subkey-revoked-clearsign', 'subkey-revoked', SIGNED + 4 * day)).resolves.toBeTruthy();
  });
  it('a signing subkey that expired', () => refuse('subkey-expired-clearsign', 'subkey-expired', /subkey that signed expired on 2026-06-01/, Date.UTC(2026, 6, 1) / 1000));
  it('RSA below 2048 bits, DSA and secp256k1', async () => {
    await refuse('rsa1024-clearsign', 'rsa1024', /RSA 1024.*does not accept/);
    await refuse('dsa-clearsign', 'dsa', /dsa.*does not accept/);
    await refuse('secp256k1-clearsign', 'secp256k1', /secp256k1.*does not accept/);
  });
  it('a SHA-1 signature', () => refuse('alice-sha1', 'alice', /weak hash/));
  it('an inline signed message and a message with two signers', async () => {
    await refuse('alice-inline', 'alice', /gpg --sign/);
    await refuse('two-signers', 'alice', /one key only/);
  });
  it('a signature dated after now, or older than the challenge', async () => {
    await refuse('alice-clearsign', 'alice', /in the future/, SIGNED - 3600);
    await expect(preparePgpEvidence({ statement, signature: read('alice-clearsign.asc'), publicKey: read('alice.pub.asc') }, { now: NOW, signedAfter: SIGNED + day })).rejects.toThrow(/older than/);
  });
  it('a private key, whatever field it lands in, without echoing it', async () => {
    const secret = read('alice.sec.asc');
    for (const input of [{ signature: read('alice-clearsign.asc'), publicKey: secret }, { signature: secret, publicKey: read('alice.pub.asc') }]) {
      const error = await preparePgpEvidence({ statement, ...input }, { now: NOW }).catch((e: Error) => e);
      expect(String(error)).toMatch(/PRIVATE key/);
      expect(String(error)).not.toContain(secret.split('\n')[3]);
    }
    await expect(readPgpPublicKey(secret)).rejects.toThrow(/PRIVATE key/);
  });
  it('oversized input, before it is parsed', async () => {
    const huge = `${read('alice.pub.asc')}${' '.repeat(PGP_LIMITS.pastedKey)}`;
    await expect(preparePgpEvidence({ statement, signature: read('alice-clearsign.asc'), publicKey: huge })).rejects.toThrow(/too large/);
    await expect(preparePgpEvidence({ statement, signature: 'x'.repeat(PGP_LIMITS.pastedSignature + 1), publicKey: read('alice.pub.asc') })).rejects.toThrow(/too large/);
  });
  it('a paste full of armor headers, before the blocks are scanned', async () => {
    const flood = '-----BEGIN PGP SIGNATURE-----\n'.repeat(10_000);
    await expect(preparePgpEvidence({ statement, signature: flood.slice(0, PGP_LIMITS.pastedSignature), publicKey: read('alice.pub.asc') })).rejects.toThrow(/only what gpg printed/);
  });
    it('two public keys at once', async () => {
    await expect(readPgpPublicKey(`${read('alice.pub.asc')}\n${read('bob.pub.asc')}`)).rejects.toThrow(/only one public key/);
  });
});

describe('OpenPGP proof: what a contact receives', () => {
  it('is small: third-party certifications and unused subkeys are not shared', async () => {
    const alice = await openpgp.readKey({ armoredKey: read('alice.pub.asc') });
    const bob = await openpgp.readPrivateKey({ armoredKey: read('bob.sec.asc') });
    const certified = await alice.signAllUsers([bob], new Date(SIGNED * 1000));
    expect(certified.users[0].otherCertifications).toHaveLength(1);
    const { evidence } = await preparePgpEvidence({ statement, signature: read('alice-clearsign.asc'), publicKey: certified.armor() }, { now: NOW });
    const shared = await openpgp.readKey({ binaryKey: fromBase64Url(evidence.key) });
    expect(shared.users.map(u => [u.userID?.userID, u.otherCertifications.length])).toEqual([['Alice Test <alice@example.org>', 0]]);
    expect(shared.subkeys.map(s => s.getFingerprint().toUpperCase())).toEqual([fpr.aliceSigningSubkey]);
    expect(fromBase64Url(evidence.key).length).toBeLessThan(1024);
  });
  it('is refused when its key, signature or statement is swapped', async () => {
    const { evidence } = await pasted('alice-clearsign', 'alice');
    const { evidence: bobs } = await pasted('bob-clearsign', 'bob');
    await expect(verifyPgpEvidence({ ...evidence, key: bobs.key }, statement, { now: NOW })).rejects.toThrow(/another key/);
    await expect(verifyPgpEvidence({ ...evidence, signature: bobs.signature }, statement, { now: NOW })).rejects.toThrow(/another key/);
    await expect(verifyPgpEvidence(evidence, `${statement} (for someone else)`, { now: NOW })).rejects.toThrow(/not over the Ghostly statement/);
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW, signedAfter: SIGNED + day })).rejects.toThrow(/older than/);
  });
  it('is refused when its key is not the one the statement names, however valid', async () => {
    const { evidence } = await pasted('alice-clearsign', 'alice');
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW, expectedFingerprint: fpr.alice.toLowerCase() })).resolves.toBeTruthy();
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW, expectedFingerprint: fpr.bob })).rejects.toThrow(/not the one the statement names/);
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW, expectedFingerprint: fpr.aliceSigningSubkey })).rejects.toThrow(/not the one/);
  });
  it('is refused when malformed or oversized, before OpenPGP parsing', async () => {
    const { evidence } = await pasted('alice-clearsign', 'alice');
    const bad: unknown[] = [null, 'x', { ...evidence, scheme: 'openpgp/2' }, { ...evidence, extra: 1 }, { ...evidence, key: `${evidence.key}=` },
      { ...evidence, key: 'A'.repeat(Math.ceil(PGP_LIMITS.sharedKey * 4 / 3) + 4) }, { ...evidence, signature: evidence.signature.slice(0, -1) + '!' }];
    for (const value of bad) await expect(verifyPgpEvidence(value as PgpEvidence, statement, { now: NOW })).rejects.toThrow(/Invalid OpenPGP proof/);
    const truncated = toBase64Url(fromBase64Url(evidence.key).slice(0, 40));
    await expect(verifyPgpEvidence({ ...evidence, key: truncated }, statement, { now: NOW })).rejects.toThrow();
  });
  it('is checked at the time the contact verifies: expired since, or carrying a revocation dated since, it is refused', async () => {
    const { evidence } = await pasted('subkey-revoked-clearsign', 'subkey-revoked', SIGNED + 4 * day);
    await expect(verifyPgpEvidence(evidence, statement, { now: SIGNED + 4 * day })).resolves.toBeTruthy();
    await expect(verifyPgpEvidence(evidence, statement, { now: NOW })).rejects.toThrow(/revoked/);
    const later = await pasted('expired-clearsign', 'expired');
    await expect(verifyPgpEvidence(later.evidence, statement, { now: Date.UTC(2026, 6, 1) / 1000 })).rejects.toThrow(/expired/);
  });
});

describe('OpenPGP proof: the person\'s key and the statement', () => {
  it('shows fingerprint and user IDs of a pasted key', async () => {
    await expect(readPgpPublicKey(read('alice.pub.asc'), { now: NOW })).resolves.toMatchObject({ fingerprint: fpr.alice, signingFingerprint: fpr.aliceSigningSubkey, userIds: ['Alice Test <alice@example.org>'] });
    expect(formatFingerprint(fpr.alice)).toMatch(/^([A-F0-9]{4} ){9}[A-F0-9]{4}$/);
  });
  it('refuses a statement gpg would alter when clearsigning', () => {
    for (const bad of ['- starts with a dash', 'trailing space ', 'ends with a newline\n', 'non-ascii é', ''])
      expect(() => assertSignableStatement(bad)).toThrow();
    expect(() => assertSignableStatement(statement)).not.toThrow();
  });
});

describe('keys.openpgp.org, only when asked', () => {
  const ok = (body: string) => vi.fn(async () => new Response(body, { status: 200 }));
  it('fetches by fingerprint or email, without credentials or referrer', async () => {
    const fetch = ok(read('alice.pub.asc'));
    await fetchKeyFromKeyserver(formatFingerprint(fpr.alice), { fetch });
    await fetchKeyFromKeyserver('alice@example.org', { fetch });
    expect(fetch.mock.calls.map(c => (c as unknown[])[0])).toEqual([`https://keys.openpgp.org/vks/v1/by-fingerprint/${fpr.alice}`, 'https://keys.openpgp.org/vks/v1/by-email/alice%40example.org']);
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  });
  it('refuses anything else, a missing key and an oversized answer', async () => {
    await expect(fetchKeyFromKeyserver('https://evil.example/', { fetch: ok('') })).rejects.toThrow(/fingerprint/);
    await expect(fetchKeyFromKeyserver(fpr.alice, { fetch: vi.fn(async () => new Response('', { status: 404 })) })).rejects.toThrow(/no key/);
    await expect(fetchKeyFromKeyserver(fpr.alice, { fetch: ok('x'.repeat(PGP_LIMITS.keyserverResponse + 1)) })).rejects.toThrow(/too large/);
  });
  it('reports the emails its copy carries, as the keyserver\'s own check, for the right key only', async () => {
    await expect(keyserverVerifiedEmails(read('alice.pub.asc'), fpr.alice, { now: NOW })).resolves.toEqual(['alice@example.org']);
    await expect(keyserverVerifiedEmails(read('bob.pub.asc'), fpr.alice, { now: NOW })).rejects.toThrow(/different key/);
  });
});

it('OpenPGP.js is only ever loaded lazily', () => {
  const source = readFileSync(new URL('../src/proofs/openpgp.ts', import.meta.url), 'utf8');
  expect(source.match(/^import .*openpgp.*$/gm)).toEqual(["import type * as OpenPGP from 'openpgp';"]);
  expect(source).toContain("import('openpgp/lightweight')");
});
