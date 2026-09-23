import { ed25519 } from '@noble/curves/ed25519.js';
import { p256, p384, p521 } from '@noble/curves/nist.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesEqual, concatBytes, fromBase64, toBase64, utf8Decode, utf8Encode } from './bytes';

/** OpenSSH signatures over a Ghostly statement (`ssh-keygen -Y sign -n ghostly`),
 * following PROTOCOL.sshsig. Everything here is local: parsing, the public key
 * the signature names and the signature itself. Which key a person *should*
 * have signed with is the caller's question (an expected fingerprint, or a
 * key list published by a forge; see the browser proof provider). */

export const SSHSIG_NAMESPACE = 'ghostly';
/** A pasted armored signature: an 8192-bit RSA key plus its signature is ~3 KB. */
export const SSHSIG_MAX_ARMOR = 6144;
/** A pasted `.pub` line; comments are dropped. */
export const SSH_PUBLIC_KEY_MAX = 4096;
const RSA_MIN_BITS = 2048;
const RSA_MAX_BITS = 8192;
const SK_APPLICATION_MAX = 256;
const SK_USER_PRESENT = 0x01;
const SK_USER_VERIFIED = 0x04;

export type SshKeyType =
  | 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521' | 'ssh-rsa'
  | 'sk-ssh-ed25519@openssh.com' | 'sk-ecdsa-sha2-nistp256@openssh.com';
export const SSH_KEY_TYPES: readonly SshKeyType[] = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];

export interface SshPublicKey {
  type: SshKeyType;
  /** The wire-format key blob, which is what fingerprints and forge key lists name. */
  blob: Uint8Array;
  /** `SHA256:` + unpadded base64, exactly as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** `type base64`, the form `.pub` files and forge key lists use (no comment). */
  line: string;
  /** Security keys only: the FIDO application, `ssh:` unless chosen at creation. */
  application?: string;
  /** RSA modulus size. */
  bits?: number;
}
export interface SshSignatureCheck {
  key: SshPublicKey;
  hashAlgorithm: 'sha256' | 'sha512';
  /** Security keys only: what the authenticator asserted for this signature. */
  securityKey?: { userPresent: boolean; userVerified: boolean; counter: number };
}

export class SshSigError extends Error {}
const fail = (message: string): never => { throw new SshSigError(message); };

class Reader {
  private at = 0;
  constructor(private bytes: Uint8Array) {}
  get done() { return this.at === this.bytes.length; }
  raw(n: number): Uint8Array {
    if (n > this.bytes.length - this.at) fail('Truncated SSH data');
    return this.bytes.subarray(this.at, this.at += n);
  }
  u8(): number { return this.raw(1)[0]; }
  u32(): number { const b = this.raw(4); return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]; }
  string(max = this.bytes.length): Uint8Array {
    const n = this.u32();
    if (n > max) fail('SSH field too long');
    return this.raw(n);
  }
  text(max: number): string {
    const b = this.string(max);
    if (!b.every(c => c >= 0x20 && c < 0x7f)) fail('SSH name is not printable ASCII');
    return utf8Decode(b);
  }
  /** Positive mpint in canonical form: no redundant leading zero, sign bit clear. */
  mpint(maxBytes: number): Uint8Array {
    const b = this.string(maxBytes + 1);
    if (!b.length || b[0] & 0x80 || (b[0] === 0 && (b.length === 1 || !(b[1] & 0x80)))) fail('Non-canonical SSH integer');
    return b[0] === 0 ? b.subarray(1) : b;
  }
  end() { if (!this.done) fail('Trailing bytes in SSH data'); }
}
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const sshString = (b: Uint8Array) => concatBytes(u32(b.length), b);

function strictBase64(text: string, max: number): Uint8Array {
  if (text.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail('Invalid base64');
  const bytes = fromBase64(text);
  if (toBase64(bytes) !== text) fail('Non-canonical base64');
  return bytes;
}
export function sshFingerprint(blob: Uint8Array): string {
  return `SHA256:${toBase64(sha256(blob)).replace(/=+$/, '')}`;
}

interface CurveInfo { name: string; curve: typeof p256 | typeof p384 | typeof p521; size: number }
const CURVES: Record<string, CurveInfo> = {
  'ecdsa-sha2-nistp256': { name: 'nistp256', curve: p256, size: 32 },
  'ecdsa-sha2-nistp384': { name: 'nistp384', curve: p384, size: 48 },
  'ecdsa-sha2-nistp521': { name: 'nistp521', curve: p521, size: 66 },
  'sk-ecdsa-sha2-nistp256@openssh.com': { name: 'nistp256', curve: p256, size: 32 },
};
interface ParsedKey extends SshPublicKey { point?: Uint8Array; rsa?: { n: Uint8Array; e: Uint8Array } }

function parseKeyBlob(blob: Uint8Array): ParsedKey {
  if (blob.length > 1100) fail('SSH public key too large');
  const r = new Reader(blob);
  const type = r.text(64) as SshKeyType;
  if (!SSH_KEY_TYPES.includes(type)) fail(`Unsupported SSH key type ${JSON.stringify(type)}`);
  const key: ParsedKey = { type, blob, fingerprint: sshFingerprint(blob), line: `${type} ${toBase64(blob)}` };
  if (type === 'ssh-ed25519' || type === 'sk-ssh-ed25519@openssh.com') {
    key.point = r.string(32);
    if (key.point.length !== 32) fail('Invalid Ed25519 public key');
    try { ed25519.Point.fromBytes(key.point, false).assertValidity(); } catch { fail('Invalid Ed25519 public key'); }
  } else if (type === 'ssh-rsa') {
    const e = r.mpint(8), n = r.mpint(RSA_MAX_BITS / 8);
    const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]));
    if (bits < RSA_MIN_BITS || bits > RSA_MAX_BITS) fail(`RSA keys must be ${RSA_MIN_BITS}-${RSA_MAX_BITS} bits`);
    if (!(e[e.length - 1] & 1) || (e.length === 1 && e[0] < 3)) fail('Invalid RSA exponent');
    key.rsa = { n, e }; key.bits = bits;
  } else {
    const info = CURVES[type];
    if (r.text(16) !== info.name) fail('ECDSA curve does not match the key type');
    key.point = r.string(1 + 2 * info.size);
    if (key.point.length !== 1 + 2 * info.size || key.point[0] !== 4) fail('Invalid ECDSA public key');
    try { info.curve.Point.fromBytes(key.point).assertValidity(); } catch { fail('Invalid ECDSA public key'); }
  }
  if (type.startsWith('sk-')) key.application = r.text(SK_APPLICATION_MAX);
  r.end();
  return key;
}

/** Parses one `.pub` style line (`type base64 [comment]`). */
export function parseSshPublicKey(line: string): SshPublicKey {
  if (typeof line !== 'string' || line.length > SSH_PUBLIC_KEY_MAX) fail('SSH public key too long');
  const m = /^\s*(\S+)\s+(\S+)(?:\s[^\n]*)?\s*$/.exec(line);
  if (!m) fail('Paste one SSH public key line (the contents of a .pub file)');
  const key = parseKeyBlob(strictBase64(m![2], SSH_PUBLIC_KEY_MAX));
  if (key.type !== m![1]) fail('SSH key type does not match its data');
  return publicView(key);
}
const publicView = ({ type, blob, fingerprint, line, application, bits }: ParsedKey): SshPublicKey =>
  ({ type, blob, fingerprint, line, ...(application !== undefined ? { application } : {}), ...(bits ? { bits } : {}) });

interface ParsedSignature { key: ParsedKey; namespace: string; hashAlgorithm: 'sha256' | 'sha512'; signature: Uint8Array }

/** Unwraps `-----BEGIN SSH SIGNATURE-----` armor and the SSHSIG envelope, without verifying. */
export function parseSshSignature(armored: string): ParsedSignature {
  if (typeof armored !== 'string' || armored.length > SSHSIG_MAX_ARMOR) fail('SSH signature too long');
  const lines = armored.replace(/\r\n/g, '\n').trim().split('\n').map(l => l.trim());
  if (lines.length < 3 || lines[0] !== '-----BEGIN SSH SIGNATURE-----' || lines[lines.length - 1] !== '-----END SSH SIGNATURE-----')
    fail('Paste the whole signature, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----');
  const r = new Reader(strictBase64(lines.slice(1, -1).join(''), SSHSIG_MAX_ARMOR));
  if (utf8Decode(r.raw(6)) !== 'SSHSIG') fail('Not an SSH signature');
  if (r.u32() !== 1) fail('Unsupported SSH signature version');
  const key = parseKeyBlob(r.string(1100));
  const namespace = r.text(64);
  if (r.string(64).length) fail('Unsupported SSH signature extension');
  const hashAlgorithm = r.text(16) as ParsedSignature['hashAlgorithm'];
  if (hashAlgorithm !== 'sha256' && hashAlgorithm !== 'sha512') fail('SSH signature hash must be sha256 or sha512');
  const signature = r.string(1200);
  r.end();
  return { key, namespace, hashAlgorithm, signature };
}

async function verifyRsa(key: ParsedKey, hash: 'SHA-256' | 'SHA-512', sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  const n = key.rsa!.n, size = n.length;
  if (sig.length > size) return false;
  const padded = new Uint8Array(size); padded.set(sig, size - sig.length);
  const b64u = (b: Uint8Array) => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const cryptoKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: b64u(n), e: b64u(key.rsa!.e), ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, padded, new Uint8Array(data));
}

function ecdsaSignature(blob: Uint8Array, size: number): Uint8Array {
  const r = new Reader(blob);
  const a = r.mpint(size), b = r.mpint(size);
  r.end();
  const out = new Uint8Array(2 * size);
  out.set(a, size - a.length); out.set(b, 2 * size - b.length);
  return out;
}

/** Verifies an armored SSHSIG over `message` in `namespace` and returns the key that
 * made it. Throws SshSigError for anything malformed, mismatched or unverifiable.
 * Security-key signatures must assert user presence (a touch) unless explicitly
 * allowed otherwise, matching OpenSSH's default for keys created without
 * `no-touch-required`. */
export async function verifySshSignature(armored: string, message: Uint8Array | string, options: { namespace?: string; allowNoTouch?: boolean } = {}): Promise<SshSignatureCheck> {
  const parsed = parseSshSignature(armored);
  const namespace = options.namespace ?? SSHSIG_NAMESPACE;
  if (parsed.namespace !== namespace) fail(`Signed for namespace ${JSON.stringify(parsed.namespace)}, not ${JSON.stringify(namespace)}. Use -n ${namespace}.`);
  const bytes = typeof message === 'string' ? utf8Encode(message) : message;
  const digest = parsed.hashAlgorithm === 'sha512' ? sha512(bytes) : sha256(bytes);
  const signed = concatBytes(utf8Encode('SSHSIG'), sshString(utf8Encode(parsed.namespace)), sshString(new Uint8Array()),
    sshString(utf8Encode(parsed.hashAlgorithm)), sshString(digest));
  const { key } = parsed;
  const r = new Reader(parsed.signature);
  const algorithm = r.text(64);
  const blob = r.string(RSA_MAX_BITS / 8);
  let securityKey: SshSignatureCheck['securityKey'];
  let data = signed;
  if (key.type.startsWith('sk-')) {
    const flags = r.u8(), counter = r.u32();
    securityKey = { userPresent: !!(flags & SK_USER_PRESENT), userVerified: !!(flags & SK_USER_VERIFIED), counter };
    data = concatBytes(sha256(utf8Encode(key.application!)), Uint8Array.of(flags), u32(counter), sha256(signed));
  }
  r.end();
  const verifyWith = async (): Promise<boolean> => {
    if (key.type === 'ssh-rsa') {
      if (algorithm !== 'rsa-sha2-512' && algorithm !== 'rsa-sha2-256') fail('RSA signatures must use rsa-sha2-256 or rsa-sha2-512');
      return verifyRsa(key, algorithm === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256', blob, data);
    }
    if (algorithm !== key.type) fail('Signature algorithm does not match the key');
    if (key.type === 'ssh-ed25519' || key.type === 'sk-ssh-ed25519@openssh.com')
      return blob.length === 64 && ed25519.verify(blob, data, key.point!, { zip215: false });
    const info = CURVES[key.type];
    return info.curve.verify(ecdsaSignature(blob, info.size), data, key.point!, { lowS: false, prehash: true });
  };
  let ok: boolean;
  try { ok = await verifyWith(); } catch (e) { if (e instanceof SshSigError) throw e; ok = false; }
  if (!ok) fail('The signature does not match this statement');
  if (securityKey && !securityKey.userPresent && !options.allowNoTouch) fail('The security key did not confirm a touch for this signature');
  return { key: publicView(key), hashAlgorithm: parsed.hashAlgorithm, ...(securityKey ? { securityKey } : {}) };
}

/** Whether two keys are the same, comparing wire blobs (comments never matter). */
export const sameSshKey = (a: Pick<SshPublicKey, 'blob'>, b: Pick<SshPublicKey, 'blob'>) => bytesEqual(a.blob, b.blob);

/** 32-byte digest of the key blob as lowercase hex: the fingerprint's bytes, in the
 * shape peer-proof external keys already use. */
export const sshKeyDigestHex = (key: Pick<SshPublicKey, 'blob'>) =>
  Array.from(sha256(key.blob), b => b.toString(16).padStart(2, '0')).join('');

/** A POSIX shell one-liner that signs `statement` exactly (no trailing newline) and
 * prints the armored signature. Refuses anything that would need escaping, so what
 * is shown is what gets signed. */
export function sshSignCommand(statement: string, keyPath = '~/.ssh/id_ed25519'): string {
  if (/['\\\n\r]/.test(statement)) fail('Statement cannot be quoted for a shell');
  if (!/^[\w~./@+-]{1,256}$/.test(keyPath)) fail('Use a plain key path without spaces or quotes');
  return `printf '%s' '${statement}' | ssh-keygen -Y sign -n ${SSHSIG_NAMESPACE} -f ${keyPath}`;
}
