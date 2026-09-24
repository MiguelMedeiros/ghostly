import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { p256 } from '@noble/curves/nist.js';
import { toBase64, utf8Encode } from '../src/bytes';
import { SSH_PUBLIC_KEY_MAX, SSHSIG_MAX_ARMOR, SshSigError, parseSshPublicKey, parseSshSignature, verifySshSignature } from '../src/sshsig';
import fixture from './fixtures/sshsig/sshsig-vectors.json';

// Every negative case starts from a real ssh-keygen vector (fixtures/sshsig/) and changes one field.
const { message, vectors } = fixture;
const byName = (name: string) => vectors.find(v => v.name === name)!;
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(p => [...p]));
const str = (b: Uint8Array | string) => { const bytes = typeof b === 'string' ? utf8Encode(b) : b; return concat(u32(bytes.length), bytes); };
const armor = (blob: Uint8Array) => `-----BEGIN SSH SIGNATURE-----\n${(toBase64(blob).match(/.{1,70}/g) ?? []).join('\n')}\n-----END SSH SIGNATURE-----\n`;
const pub = (blob: Uint8Array, type = 'ssh-ed25519') => `${type} ${toBase64(blob)}`;
/** Splits an SSH wire blob into its length-prefixed strings. */
function fields(blob: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < blob.length;) { const n = new DataView(blob.buffer, blob.byteOffset + at).getUint32(0); out.push(blob.subarray(at + 4, at + 4 + n)); at += 4 + n; }
  return out;
}
const envelope = (key: Uint8Array, signature: Uint8Array, hash = 'sha512', namespace = 'ghostly') =>
  armor(concat(utf8Encode('SSHSIG'), u32(1), str(key), str(namespace), str(new Uint8Array()), str(hash), str(signature)));
const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

const ED = parseSshPublicKey(byName('ed25519').publicKey);
const [, ED_POINT] = fields(ED.blob);
const P256 = parseSshPublicKey(byName('ecdsa-p256').publicKey);
const [, , P256_POINT] = fields(P256.blob);

describe('public key blobs', () => {
  it('refuses a type name that is too long or not printable', () => {
    expect(() => parseSshPublicKey(pub(concat(str('x'.repeat(65)), str(ED_POINT))))).toThrow('SSH field too long');
    expect(() => parseSshPublicKey(pub(concat(str('ssh-ed25519\u0001'), str(ED_POINT))))).toThrow('SSH name is not printable ASCII');
    expect(() => parseSshPublicKey(pub(concat(str('ssh-\u00e9d25519'), str(ED_POINT))))).toThrow('SSH name is not printable ASCII');
  });

  it('refuses an Ed25519 key of the wrong size or off the curve', () => {
    expect(() => parseSshPublicKey(pub(concat(str('ssh-ed25519'), str(ED_POINT.subarray(0, 31)))))).toThrow('Invalid Ed25519 public key');
    expect(() => parseSshPublicKey(pub(concat(str('ssh-ed25519'), str(concat(ED_POINT, Uint8Array.of(0))))))).toThrow('SSH field too long');
    // y = 2 has no x on edwards25519.
    const offCurve = new Uint8Array(32); offCurve[0] = 2;
    expect(() => parseSshPublicKey(pub(concat(str('ssh-ed25519'), str(offCurve))))).toThrow('Invalid Ed25519 public key');
    expect(() => parseSshPublicKey(pub(concat(str('ssh-ed25519'), str(ED_POINT), Uint8Array.of(0))))).toThrow('Trailing bytes in SSH data');
  });

  it('refuses an ECDSA key naming another curve, compressed, truncated or off the curve', () => {
    const t = 'ecdsa-sha2-nistp256';
    expect(() => parseSshPublicKey(pub(concat(str(t), str('nistp384'), str(P256_POINT)), t))).toThrow('ECDSA curve does not match the key type');
    expect(() => parseSshPublicKey(pub(concat(str(t), str('nistp256'), str(P256_POINT.subarray(0, 64))), t))).toThrow('Invalid ECDSA public key');
    expect(() => parseSshPublicKey(pub(concat(str(t), str('nistp256'), str(Uint8Array.of(0x02, ...P256_POINT.subarray(1)))), t))).toThrow('Invalid ECDSA public key');
    const moved = P256_POINT.slice(); moved[64] ^= 1;
    expect(() => parseSshPublicKey(pub(concat(str(t), str('nistp256'), str(moved)), t))).toThrow('Invalid ECDSA public key');
  });

  it('refuses non-canonical RSA integers and weak exponents', () => {
    const n = new Uint8Array(257); n[1] = 0x80; n[256] = 1; // 2048 bits, positive, canonical
    const rsa = (e: Uint8Array, modulus = n) => pub(concat(str('ssh-rsa'), str(e), str(modulus)), 'ssh-rsa');
    expect(parseSshPublicKey(rsa(Uint8Array.of(1, 0, 1))).bits).toBe(2048);
    for (const e of [new Uint8Array(0), Uint8Array.of(0x80, 1), Uint8Array.of(0, 1), Uint8Array.of(0)])
      expect(() => parseSshPublicKey(rsa(e)), String([...e])).toThrow('Non-canonical SSH integer');
    for (const e of [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(1, 0)]) expect(() => parseSshPublicKey(rsa(e)), String([...e])).toThrow('Invalid RSA exponent');
    expect(() => parseSshPublicKey(rsa(Uint8Array.of(1, 0, 1), n.subarray(1)))).toThrow('Non-canonical SSH integer');
    expect(() => parseSshPublicKey(rsa(Uint8Array.of(1, 0, 1, 1, 0, 1, 1, 0, 1, 1)))).toThrow('SSH field too long');
  });

  it('refuses a blob over 1100 bytes before parsing it', () => {
    const big = concat(str('ssh-ed25519'), str(ED_POINT), new Uint8Array(1100));
    expect(() => parseSshPublicKey(pub(big))).toThrow('SSH public key too large');
  });

  it('refuses lines that are too long, not one key, or not canonical base64', () => {
    expect(() => parseSshPublicKey(`${ED.line} ${'c'.repeat(SSH_PUBLIC_KEY_MAX)}`)).toThrow('SSH public key too long');
    expect(() => parseSshPublicKey(42 as unknown as string)).toThrow('SSH public key too long');
    for (const line of ['ssh-ed25519', '', '   ', `\n${ED.line}x`]) expect(() => parseSshPublicKey(line), line).toThrow(SshSigError);
    // Before "==" the last character carries 4 padding bits: a set one decodes to the same bytes, a second spelling.
    const b64 = toBase64(concat(ED.blob, Uint8Array.of(0)));
    expect(b64.endsWith('A==')).toBe(true);
    expect(() => parseSshPublicKey(`ssh-ed25519 ${b64}`)).toThrow('Trailing bytes in SSH data');
    expect(() => parseSshPublicKey(`ssh-ed25519 ${b64.replace(/A==$/, 'B==')}`)).toThrow('Non-canonical base64');
  });

  it('never throws anything but an SshSigError on arbitrary lines', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }).map(b => `ssh-ed25519 ${toBase64(b)}`)), line => {
      try { parseSshPublicKey(line); } catch (e) { expect(e).toBeInstanceOf(SshSigError); }
    }), { numRuns: 300 });
  });
});

describe('signature envelopes', () => {
  it('verifies a message given as bytes the same as text', async () => {
    const v = byName('ed25519');
    await expect(verifySshSignature(v.signature, utf8Encode(message))).resolves.toMatchObject({ key: { type: 'ssh-ed25519' } });
    await refused(verifySshSignature(v.signature, utf8Encode(`${message}.`)), /does not match this statement/);
  });

  it('refuses an Ed25519 signature of the wrong size, and trailing bytes after it', async () => {
    const sig = parseSshSignature(byName('ed25519').signature);
    const [algorithm, raw] = fields(sig.signature);
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(algorithm), str(raw.subarray(0, 63)))), message), /does not match this statement/);
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(algorithm), str(raw), Uint8Array.of(0))), message), /Trailing bytes/);
  });

  it('refuses ECDSA signatures with non-canonical or out-of-range integers, never with a raw error', async () => {
    const sig = parseSshSignature(byName('ecdsa-p256').signature);
    const [algorithm, inner] = fields(sig.signature);
    const [r, s] = fields(inner);
    const wrap = (a: Uint8Array, b: Uint8Array, extra = new Uint8Array()) => envelope(sig.key.blob, concat(str(algorithm), str(concat(str(a), str(b), extra))), sig.hashAlgorithm);
    await expect(verifySshSignature(wrap(r, s), message)).resolves.toBeTruthy();
    await refused(verifySshSignature(wrap(Uint8Array.of(0, ...r), s), message), /Non-canonical SSH integer/);
    await refused(verifySshSignature(wrap(r, new Uint8Array()), message), /Non-canonical SSH integer/);
    await refused(verifySshSignature(wrap(r, s, Uint8Array.of(0)), message), /Trailing bytes/);
    // r equal to the group order: well-formed, out of range; refused as a mismatch.
    const order = p256.Point.Fn.ORDER.toString(16).padStart(64, '0');
    const n = Uint8Array.from(Buffer.from(order, 'hex'));
    const err = await verifySshSignature(wrap(n[0] & 0x80 ? Uint8Array.of(0, ...n) : n, s), message).catch(e => e);
    expect(err).toBeInstanceOf(SshSigError);
    expect(err.message).toBe('The signature does not match this statement');
    // One byte wider than the curve, without a sign byte: canonical as an mpint, too wide for the curve.
    const wide = await verifySshSignature(wrap(Uint8Array.of(1, ...r.subarray(r.length - 32)), s), message).catch(e => e);
    expect(wide).toBeInstanceOf(SshSigError);
    expect(wide.message).toBe('The signature does not match this statement');
    // The high-S twin is a valid ECDSA signature, as OpenSSH accepts.
    const high = (p256.Point.Fn.ORDER - BigInt(`0x${Buffer.from(s).toString('hex')}`)).toString(16).padStart(64, '0');
    const hb = Uint8Array.from(Buffer.from(high, 'hex'));
    await expect(verifySshSignature(wrap(r, hb[0] & 0x80 ? Uint8Array.of(0, ...hb) : hb), message)).resolves.toBeTruthy();
  });

  it('refuses an RSA signature longer than the modulus, and one relabelled to another hash', async () => {
    const sig = parseSshSignature(byName('rsa-2048').signature);
    const [algorithm, raw] = fields(sig.signature);
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(algorithm), str(concat(Uint8Array.of(1), raw))), sig.hashAlgorithm), message), /does not match this statement/);
    const other = new TextDecoder().decode(algorithm) === 'rsa-sha2-512' ? 'rsa-sha2-256' : 'rsa-sha2-512';
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(other), str(raw)), sig.hashAlgorithm), message), /does not match this statement/);
    // A signature shorter than the modulus is left-padded, as OpenSSH does; a zero-length one fails.
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(algorithm), str(new Uint8Array())), sig.hashAlgorithm), message), /does not match this statement/);
  });

  it('refuses a security-key signature without its flags and counter', async () => {
    const sig = parseSshSignature(byName('sk-ed25519').signature);
    const [algorithm, raw] = fields(sig.signature);
    await refused(verifySshSignature(envelope(sig.key.blob, concat(str(algorithm), str(raw)), sig.hashAlgorithm), message), /Truncated SSH data/);
    const full = sig.signature;
    await refused(verifySshSignature(envelope(sig.key.blob, concat(full, Uint8Array.of(0)), sig.hashAlgorithm), message), /Trailing bytes/);
  });

  it('binds the security key signature to its flags and counter', async () => {
    const sig = parseSshSignature(byName('sk-ecdsa-p256').signature);
    const tampered = sig.signature.slice();
    tampered[tampered.length - 1] ^= 1; // the counter's last byte
    await refused(verifySshSignature(envelope(sig.key.blob, tampered, sig.hashAlgorithm), message), /does not match this statement/);
  });

  it('refuses a magic that is not even text with an SshSigError, not a decoding error', async () => {
    const err = await verifySshSignature(armor(Uint8Array.of(0x53, 0x53, 0x48, 0, 0, 0x80, ...new Uint8Array(40))), message).catch(e => e);
    expect(err).toBeInstanceOf(SshSigError);
    expect(err.message).toBe('Not an SSH signature');
    expect(() => parseSshSignature(armor(Uint8Array.of(0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0, 0, 0, 1)))).toThrow(SshSigError);
  });

  it('refuses an armor body at the size limit that is not base64, and the empty envelope', async () => {
    await refused(verifySshSignature(`-----BEGIN SSH SIGNATURE-----\n${'A'.repeat(SSHSIG_MAX_ARMOR - 60)}\n-----END SSH SIGNATURE-----`, message), /Invalid base64|Not an SSH signature|Truncated/);
    await refused(verifySshSignature('-----BEGIN SSH SIGNATURE-----\n\n-----END SSH SIGNATURE-----', message), /Truncated SSH data/);
    await refused(verifySshSignature(42 as unknown as string, message), /too long/);
  });

  it('never throws anything but an SshSigError on arbitrary envelopes', async () => {
    const good = parseSshSignature(byName('ed25519').signature);
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 120 }), fc.nat({ max: 200 }), async (noise, cut) => {
      const blob = concat(utf8Encode('SSHSIG'), u32(1), str(good.key.blob), str('ghostly'), str(new Uint8Array()), str('sha512'), str(good.signature));
      for (const candidate of [noise, concat(blob.subarray(0, cut), noise)]) {
        const err = await verifySshSignature(armor(candidate), message).then(() => undefined, e => e);
        if (err) expect(err).toBeInstanceOf(SshSigError);
      }
    }), { numRuns: 150 });
  });
});
