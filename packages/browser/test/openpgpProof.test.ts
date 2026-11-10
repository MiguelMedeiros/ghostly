import { generatePrimeSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';
import * as lightweight from 'openpgp/lightweight';
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

describe('OpenPGP proof: RSA keys sized before any signature is verified', () => {
  const big = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  const bytesOf = (x: bigint) => { const hex = x.toString(16); return Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')); };
  const inverse = (a: bigint, m: bigint) => {
    let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
    while (r1) { const q = r0 / r1; [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]; }
    return r0 === 1n ? ((s0 % m) + m) % m : 0n;
  };
  /** A valid, self-certified RSA key with an exponent of `exponentBits` bits, and its proof of the statement. */
  async function rsaProof(exponentBits: number, modulusBits = 2048) {
    for (;;) {
      let p = generatePrimeSync(modulusBits / 2, { bigint: true }), q = generatePrimeSync(modulusBits / 2, { bigint: true });
      if (p > q) [p, q] = [q, p];
      const phi = (p - 1n) * (q - 1n);
      const e = exponentBits === 17 ? 65537n : big(randomBytes(exponentBits / 8)) | (1n << BigInt(exponentBits - 1)) | 1n;
      const d = inverse(e, phi);
      if (!d) continue;
      const packet = new openpgp.SecretKeyPacket(new Date(Date.now() - day * 1000));
      Object.assign(packet, { algorithm: openpgp.enums.publicKey.rsaEncryptSign, isEncrypted: false,
        publicParams: { n: bytesOf(p * q), e: bytesOf(e) }, privateParams: { d: bytesOf(d), p: bytesOf(p), q: bytesOf(q), u: bytesOf(inverse(p, q)) } });
      await packet.computeFingerprintAndKeyID();
      const packets = new openpgp.PacketList<openpgp.AnyPacket>(); packets.push(packet);
      const { privateKey, publicKey } = await openpgp.reformatKey({ privateKey: new openpgp.PrivateKey(packets as openpgp.PacketList<openpgp.AnyKeyPacket>), userIDs: [{ name: 'Erin Test', email: 'erin@example.org' }], format: 'object' });
      const signature = await openpgp.sign({ message: await openpgp.createMessage({ text: statement }), signingKeys: privateKey, detached: true, format: 'binary' }) as Uint8Array;
      const evidence: PgpEvidence = { scheme: 'openpgp/1', key: toBase64Url(publicKey.write()), signature: toBase64Url(signature) };
      return { evidence, publicKey };
    }
  }
  /** As Chromium (BoringSSL refuses an RSA exponent over 33 bits): OpenPGP.js then verifies in JavaScript. */
  function chromiumWebCrypto() {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    return vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((format: string, data: JsonWebKey, ...rest: unknown[]) => {
      if (format === 'jwk' && data.kty === 'RSA' && fromBase64Url(data.e!).length > 5) return Promise.reject(new DOMException('exponent too large', 'DataError'));
      return (importKey as (...args: unknown[]) => Promise<CryptoKey>)(format, data, ...rest);
    }) as typeof crypto.subtle.importKey);
  }

  it.each([16384, 60000])('a %i-bit public exponent is refused, before any signature is verified', async exponentBits => {
    const { evidence, publicKey } = await rsaProof(exponentBits);
    expect(fromBase64Url(evidence.key).length).toBeLessThanOrEqual(PGP_LIMITS.sharedKey);
    const webcrypto = chromiumWebCrypto();
    try {
      await expect(verifyPgpEvidence(evidence, statement)).rejects.toThrow(new RegExp(`${exponentBits}-bit public exponent.*does not accept`));
      await expect(readPgpPublicKey(publicKey.armor())).rejects.toThrow(/public exponent/);
      expect(webcrypto).not.toHaveBeenCalled();
    } finally { webcrypto.mockRestore(); }
  }, 60_000);
  it('an RSA key with the usual exponent still proves, and one over 8192 bits is refused', async () => {
    const { evidence } = await rsaProof(17, 4096);
    const webcrypto = chromiumWebCrypto();
    try { await expect(verifyPgpEvidence(evidence, statement)).resolves.toMatchObject({ algorithm: 'RSA 4096', userIds: ['Erin Test <erin@example.org>'] }); }
    finally { webcrypto.mockRestore(); }
    const key = await openpgp.readKey({ binaryKey: fromBase64Url(evidence.key) });
    (key.keyPacket as unknown as { publicParams: { n: Uint8Array } }).publicParams.n = Uint8Array.from({ length: 1040 }, () => 0xff);
    await expect(verifyPgpEvidence({ ...evidence, key: toBase64Url(key.write()) }, statement)).rejects.toThrow(/RSA 8320.*does not accept/);
  }, 60_000);
});

describe('OpenPGP proof: a contact\'s key costs a bounded number of verifications', () => {
  // Brainpool and Ed448 have no WebCrypto path in OpenPGP.js: every verification runs in JavaScript.
  // The Node build cannot make brainpool keys; the lightweight build is the one the app (and the verifier here) runs.
  const kinds = [['brainpoolP512r1', { type: 'ecc', curve: 'brainpoolP512r1' }], ['Ed448', { type: 'curve448' }]] as const;
  async function proof(kind: (typeof kinds)[number][1], options: { userIds?: number; subkey?: boolean; date?: Date } = {}) {
    const date = options.date ?? new Date();
    const userIDs = Array.from({ length: options.userIds ?? 1 }, (_, i) => ({ name: `Gil Test ${i}`, email: `gil${i}@example.org` }));
    const { privateKey, publicKey } = await lightweight.generateKey({ ...kind, userIDs, date, subkeys: options.subkey ? [{ sign: true }] : [{}], format: 'object' } as lightweight.GenerateKeyOptions & { format: 'object' });
    const signature = await lightweight.sign({ message: await lightweight.createMessage({ text: statement }), signingKeys: privateKey, detached: true, format: 'binary' }) as Uint8Array;
    return { privateKey, publicKey, signature, evidence: (key = publicKey): PgpEvidence => ({ scheme: 'openpgp/1', key: toBase64Url(key.write()), signature: toBase64Url(signature) }) };
  }
  /** A copy whose hashed part is unchanged (so it passes the 2-byte hash prefix check) and whose value is not. */
  async function spoiled(sig: lightweight.SignaturePacket) {
    const bytes = sig.write().slice(); bytes[bytes.length - 3] ^= 0x5a; // inside the last MPI
    const copy = new lightweight.SignaturePacket(); await (copy as unknown as { read(b: Uint8Array): Promise<void> }).read(bytes);
    return copy;
  }
  /** Counts signature verifications, and those that failed on the signature value itself (the costly ones). */
  function counting() {
    const verify = lightweight.SignaturePacket.prototype.verify;
    const counts = { calls: 0, failed: 0 };
    const spy = vi.spyOn(lightweight.SignaturePacket.prototype, 'verify').mockImplementation(function (this: lightweight.SignaturePacket, ...args) {
      counts.calls++;
      return verify.apply(this, args).catch((e: Error) => { if (e.message === 'Signature verification failed') counts.failed++; throw e; });
    });
    return { counts, restore: () => spy.mockRestore() };
  }

  it.each(kinds)('%s: a key padded with spoiled copies of its self-certification is refused after one failed verification', async (_, kind) => {
    const { publicKey, evidence } = await proof(kind);
    const certs = publicKey.users[0].selfCertifications;
    const copy = await spoiled(certs[0]);
    // One copy is within any per-user-ID count; the probe's padding filled the 9 KiB.
    for (const copies of [1, 30]) {
      certs.splice(1);
      while (certs.length <= copies && publicKey.write().length + copy.write().length + 2 <= PGP_LIMITS.sharedKey) certs.push(await spoiled(certs[0]));
      const { counts, restore } = counting();
      try { await expect(verifyPgpEvidence(evidence(), statement)).rejects.toThrow(/Invalid OpenPGP proof/); }
      finally { restore(); }
      expect(counts.failed).toBeLessThanOrEqual(1);
    }
  }, 60_000);
  it('a signing subkey padded with spoiled copies of its binding signature is refused after one failed verification', async () => {
    const { publicKey, evidence } = await proof(kinds[0][1], { subkey: true });
    const bindings = publicKey.subkeys[0].bindingSignatures;
    bindings.push(await spoiled(bindings[0]));
    const { counts, restore } = counting();
    try { await expect(verifyPgpEvidence(evidence(), statement)).rejects.toThrow(/Invalid OpenPGP proof/); }
    finally { restore(); }
    expect(counts.failed).toBeLessThanOrEqual(1);
  }, 60_000);
  it('a key with more signatures than a minimal key carries is refused before any is verified', async () => {
    const { publicKey, evidence } = await proof(kinds[0][1]);
    const certs = publicKey.users[0].selfCertifications;
    certs.push(certs[0], certs[0]); // valid, and still more self-certifications than one user ID needs
    const { counts, restore } = counting();
    try { await expect(verifyPgpEvidence(evidence(), statement)).rejects.toThrow(/Invalid OpenPGP proof/); }
    finally { restore(); }
    expect(counts.calls).toBe(0);
  }, 60_000);
  it.each(kinds)('%s: an honest key still proves, with 16 user IDs, a signing subkey, and self-signatures superseded since', async (_, kind) => {
    const before = new Date(Date.now() - 10 * day * 1000);
    const { privateKey, publicKey, signature } = await proof(kind, { userIds: PGP_LIMITS.userIds, date: before });
    const { evidence, verified } = await preparePgpEvidence({ statement, signature: lightweight.armor(lightweight.enums.armor.signature, signature), publicKey: publicKey.armor() });
    expect(verified.userIds).toHaveLength(PGP_LIMITS.userIds);
    await expect(verifyPgpEvidence(evidence, statement)).resolves.toMatchObject({ fingerprint: verified.fingerprint, userIds: verified.userIds });
    // Expiry extended twice (gpg --quick-set-expire): every user ID gets newer self-certifications, the old ones stay.
    const userIDs = publicKey.users.map(u => ({ name: u.userID!.name, email: u.userID!.email }));
    let extended = publicKey;
    for (const days of [5, 3]) {
      const { publicKey: again } = await lightweight.reformatKey({ privateKey, userIDs, date: new Date(Date.now() - days * day * 1000), format: 'object' });
      extended = await extended.update(again);
    }
    expect(extended.users[0].selfCertifications).toHaveLength(3);
    const signed = await proof(kind, { subkey: true });
    const withSubkey = await preparePgpEvidence({ statement, signature: lightweight.armor(lightweight.enums.armor.signature, signed.signature), publicKey: signed.publicKey.armor() });
    await expect(verifyPgpEvidence(withSubkey.evidence, statement)).resolves.toMatchObject({ signingFingerprint: signed.publicKey.subkeys[0].getFingerprint().toUpperCase() });
    const again = await preparePgpEvidence({ statement, signature: lightweight.armor(lightweight.enums.armor.signature, signature), publicKey: extended.armor() });
    const shared = await lightweight.readKey({ binaryKey: fromBase64Url(again.evidence.key) });
    expect(shared.users.map(u => u.selfCertifications.length)).toEqual(Array(PGP_LIMITS.userIds).fill(1));
    await expect(verifyPgpEvidence(again.evidence, statement)).resolves.toMatchObject({ fingerprint: verified.fingerprint, userIds: verified.userIds });
  }, 60_000);
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
