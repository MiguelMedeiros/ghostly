import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64, utf8Encode } from '../src/bytes';
import { parseSshPublicKey, parseSshSignature, sameSshKey, sshKeyDigestHex, sshSignCommand, SshSigError, verifySshSignature, SSHSIG_MAX_ARMOR } from '../src/sshsig';
import fixture from './fixtures/sshsig/sshsig-vectors.json';
// covers: proofs.ssh

// Every vector was made by a real ssh-keygen (see fixtures/sshsig/generate.sh);
// the security-key ones through OpenSSH's own software authenticator.
const { message, vectors } = fixture;
const byName = (name: string) => vectors.find(v => v.name === name)!;
const expectedTypes: Record<string, string> = {
  ed25519: 'ssh-ed25519', 'ed25519-sha256': 'ssh-ed25519', 'ecdsa-p256': 'ecdsa-sha2-nistp256', 'ecdsa-p384': 'ecdsa-sha2-nistp384',
  'ecdsa-p521': 'ecdsa-sha2-nistp521', 'rsa-2048': 'ssh-rsa', 'rsa-3072-sha256': 'ssh-rsa',
  'sk-ed25519': 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-p256': 'sk-ecdsa-sha2-nistp256@openssh.com',
};
const armor = (blob: Uint8Array) => `-----BEGIN SSH SIGNATURE-----\n${toBase64(blob).match(/.{1,70}/g)!.join('\n')}\n-----END SSH SIGNATURE-----\n`;
const unarmor = (text: string) => fromBase64(text.trim().split('\n').slice(1, -1).join(''));
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(p => [...p]));
const str = (b: Uint8Array) => concat(u32(b.length), b);
interface Fields { version?: number; key: Uint8Array; namespace: string; reserved?: Uint8Array; hash: string; signature: Uint8Array }
const fields = (p: ReturnType<typeof parseSshSignature>): Fields => ({ key: p.key.blob, namespace: p.namespace, hash: p.hashAlgorithm, signature: p.signature });
/** Rebuilds an SSHSIG envelope field by field, to change exactly one thing. */
const envelope = (f: Fields) => armor(concat(utf8Encode('SSHSIG'), u32(f.version ?? 1), str(f.key), str(utf8Encode(f.namespace)),
  str(f.reserved ?? new Uint8Array()), str(utf8Encode(f.hash)), str(f.signature)));
const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

describe('SSHSIG verification against ssh-keygen vectors', () => {
  it('covers every key type the fixture promises', () => {
    expect(vectors.map(v => v.name).sort()).toEqual([...Object.keys(expectedTypes), 'sk-ed25519-no-touch'].sort());
  });

  for (const [name, type] of Object.entries(expectedTypes)) {
    it(`accepts ${name} and names the signing key`, async () => {
      const v = byName(name);
      const check = await verifySshSignature(v.signature, message);
      const pub = parseSshPublicKey(v.publicKey);
      expect(check.key.type).toBe(type);
      expect(check.key.line).toBe(v.publicKey);
      expect(sameSshKey(check.key, pub)).toBe(true);
      expect(check.key.fingerprint).toBe(pub.fingerprint);
      expect(check.hashAlgorithm).toBe(name.endsWith('sha256') ? 'sha256' : 'sha512');
      if (type.startsWith('sk-')) expect(check.securityKey).toMatchObject({ userPresent: true });
      if (type === 'ssh-rsa') expect(check.key.bits).toBe(name === 'rsa-2048' ? 2048 : 3072);
    });

    it(`refuses ${name} over another statement, in another namespace, or tampered`, async () => {
      const v = byName(name);
      await refused(verifySshSignature(v.signature, `${message} `), /does not match this statement/);
      await refused(verifySshSignature(v.signature, message.replace('2027-04-15', '2028-04-15')), /does not match/);
      await refused(verifySshSignature(v.otherNamespace, message), /namespace "git", not "ghostly"/);
      await refused(verifySshSignature(v.signature, message, { namespace: 'git' }), /namespace "ghostly", not "git"/);
      const blob = unarmor(v.signature);
      blob[blob.length - 9] ^= 1;
      await expect(verifySshSignature(armor(blob), message)).rejects.toThrow(SshSigError);
    });
  }

  it('refuses a security key that did not confirm a touch, unless allowed', async () => {
    const v = byName('sk-ed25519-no-touch');
    await refused(verifySshSignature(v.signature, message), /did not confirm a touch/);
    expect((await verifySshSignature(v.signature, message, { allowNoTouch: true })).securityKey?.userPresent).toBe(false);
  });

  it('refuses a signature whose embedded key was swapped for another', async () => {
    const sig = parseSshSignature(byName('ed25519').signature);
    const other = parseSshPublicKey(byName('sk-ed25519').publicKey);
    const fresh = parseSshPublicKey(byName('ecdsa-p256').publicKey);
    await refused(verifySshSignature(envelope({ ...fields(sig), key: fresh.blob }), message), /does not match the key/);
    // Same type, another key: the envelope parses, the signature does not verify.
    const otherEd = new Uint8Array([0, 0, 0, 11, ...utf8Encode('ssh-ed25519'), 0, 0, 0, 32, ...other.blob.subarray(34, 66)]);
    await refused(verifySshSignature(envelope({ ...fields(sig), key: otherEd }), message), /does not match this statement/);
  });
});

describe('SSHSIG parsing limits', () => {
  const good = byName('ed25519').signature;
  it('requires the armor, whole and alone', async () => {
    await refused(verifySshSignature(good.split('\n').slice(1).join('\n'), message), /Paste the whole signature/);
    await refused(verifySshSignature(good.replace('-----END SSH SIGNATURE-----', ''), message), /Paste the whole signature/);
    await refused(verifySshSignature(good.replace('SIGNATURE-----\n', 'SIGNATURE-----\n!'), message), /base64/);
    await refused(verifySshSignature(good + 'x'.repeat(SSHSIG_MAX_ARMOR), message), /too long/);
    // Surrounding whitespace and Windows line endings are how people paste it.
    await expect(verifySshSignature(`\n  ${good.replace(/\n/g, '\r\n')}  \n`, message)).resolves.toBeTruthy();
  });
  it('refuses trailing bytes, other versions, unknown hash and reserved data', async () => {
    const blob = unarmor(good), f = fields(parseSshSignature(good));
    await expect(verifySshSignature(envelope(f), message)).resolves.toBeTruthy();
    await refused(verifySshSignature(armor(new Uint8Array([...blob, 0])), message), /Trailing bytes/);
    await refused(verifySshSignature(envelope({ ...f, version: 2 }), message), /version/);
    await refused(verifySshSignature(envelope({ ...f, hash: 'sha384' }), message), /sha256 or sha512/);
    await refused(verifySshSignature(envelope({ ...f, reserved: utf8Encode('x') }), message), /extension/);
    await refused(verifySshSignature(armor(blob.subarray(0, 40)), message), /Truncated/);
    await refused(verifySshSignature(armor(new Uint8Array([...utf8Encode('SSHSIH'), ...blob.subarray(6)])), message), /Not an SSH signature/);
  });
  it('refuses an RSA signature made with SHA-1 (ssh-rsa)', async () => {
    const f = fields(parseSshSignature(byName('rsa-2048').signature));
    const inner = new DataView(f.signature.buffer, f.signature.byteOffset);
    const raw = f.signature.subarray(4 + inner.getUint32(0) + 4);
    await refused(verifySshSignature(envelope({ ...f, signature: concat(str(utf8Encode('ssh-rsa')), str(raw)) }), message), /rsa-sha2-256 or rsa-sha2-512/);
  });
});

describe('SSH public keys', () => {
  it('parses .pub lines with comments and matches ssh-keygen fingerprints', () => {
    const v = byName('ed25519');
    const key = parseSshPublicKey(`${v.publicKey} someone@laptop\n`);
    expect(key.line).toBe(v.publicKey);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(sshKeyDigestHex(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(sshKeyDigestHex(key), 'hex').toString('base64').replace(/=+$/, '')).toBe(key.fingerprint.slice(7));
    expect(parseSshPublicKey(byName('sk-ed25519').publicKey).application).toBe('ssh:');
  });
  it('refuses private keys, mismatched types, small RSA and garbage', () => {
    expect(() => parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow(SshSigError);
    const v = byName('ed25519');
    expect(() => parseSshPublicKey(v.publicKey.replace('ssh-ed25519', 'ssh-rsa'))).toThrow(/does not match/);
    expect(() => parseSshPublicKey('ssh-dss AAAAB3NzaC1kc3MAAAA=')).toThrow(SshSigError);
    // A 1024-bit RSA key (e=65537, n = 2^1023 + 1): too small to prove anything.
    const n = new Uint8Array(129); n[1] = 0x80; n[128] = 1;
    const blob = new Uint8Array([0, 0, 0, 7, ...utf8Encode('ssh-rsa'), 0, 0, 0, 3, 1, 0, 1, 0, 0, 0, 129, ...n]);
    expect(() => parseSshPublicKey(`ssh-rsa ${toBase64(blob)}`)).toThrow(/2048-8192 bits/);
  });
});

describe('the command people run', () => {
  it('signs exactly the statement and refuses anything needing escapes', () => {
    expect(sshSignCommand(message)).toBe(`printf '%s' '${message}' | ssh-keygen -Y sign -n ghostly -f ~/.ssh/id_ed25519`);
    expect(sshSignCommand('x', '~/.ssh/id_ecdsa_sk.pub')).toContain('-f ~/.ssh/id_ecdsa_sk.pub');
    expect(() => sshSignCommand("it's")).toThrow();
    expect(() => sshSignCommand('x', 'my key; rm -rf ~')).toThrow();
  });
});
