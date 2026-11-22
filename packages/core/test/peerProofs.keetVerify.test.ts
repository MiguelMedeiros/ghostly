import { describe, expect, it, vi } from 'vitest';
import type IdentityKeyType from 'keet-identity-key';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { createIdentity } from '../src/identity';
import { toBase64Url, utf8Encode } from '../src/bytes';
import { importedProof, proofStatement, verifyPeerProof, type ProofChallenge } from '../src/peerProofs';

// covers: proofs.peer-proofs

// Loading the SDK pulls in its keychain and every BIP39 word list (~1.3 MB in the web build).
// Checking a contact's proof must not: only importing an identity from a mnemonic needs them.
const loaded = vi.hoisted(() => ({ sdk: false }));
vi.mock('keet-identity-key', async importOriginal => {
  loaded.sdk = true;
  return importOriginal();
});
const sdk = async () => (await vi.importActual<{ default: typeof IdentityKeyType }>('keet-identity-key')).default;

const NOW = Math.floor(Date.now() / 1000);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function challenge(externalKey: string): ProofChallenge {
  return { adapter: 'keet-import', externalKey, subject: createIdentity().pubKeyZ32, audience: createIdentity().pubKeyZ32, context: 'a'.repeat(64),
    session: 'b'.repeat(64), nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), issuedAt: NOW, expiresAt: NOW + 86400 };
}

describe('Keet proof verification', () => {
  it('checks an SDK attestation without loading the SDK', async () => {
    const IdentityKey = await sdk();
    const keet = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
    const c = challenge(hex(keet.identityPublicKey));
    const proof = IdentityKey.attestData(utf8Encode(proofStatement(c)), keet.identityKeyPair);
    await expect(verifyPeerProof(await importedProof(c, proof), c)).resolves.toBeUndefined();
    expect(loaded.sdk).toBe(false);
  });

  it('agrees with the SDK verifier on every single-byte change of an attestation', async () => {
    const IdentityKey = await sdk();
    const keet = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
    const c = challenge(hex(keet.identityPublicKey));
    const data = utf8Encode(proofStatement(c));
    const good = new Uint8Array(IdentityKey.attestData(data, keet.identityKeyPair));
    const sdkAccepts = (proof: Uint8Array) => { try { return !!IdentityKey.verify(Buffer.from(proof), Buffer.from(data), { expectedIdentity: Buffer.from(keet.identityPublicKey) }); } catch { return false; } };
    const ours = async (proof: Uint8Array) => verifyPeerProof(await importedProof(c, proof), c).then(() => true, () => false);
    expect(await ours(good)).toBe(true);
    for (let i = 0; i < good.length; i++) for (const mask of [0x01, 0x80]) {
      const changed = Uint8Array.from(good, (b, j) => (j === i ? b ^ mask : b));
      // Version, chain length and data flag are pinned to one spelling; the SDK reads other spellings too.
      expect(await ours(changed), `byte ${i} ^ ${mask}`).toBe([0, 41, 42].includes(i) ? false : sdkAccepts(changed));
    }
  });

  it('reads a signed epoch as the SDK does, up to 2^53 - 1 seconds', async () => {
    const IdentityKey = await sdk();
    const keet = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
    const c = challenge(hex(keet.identityPublicKey));
    const data = utf8Encode(proofStatement(c));
    // Signed by hand, as another implementation could: the SDK's own attestData refuses such epochs.
    const attest = (seconds: bigint) => {
      const epoch = new Uint8Array(8);
      new DataView(epoch.buffer).setBigUint64(0, seconds, true);
      const signature = ed25519.sign(new Uint8Array([1, ...epoch, ...keet.identityPublicKey, ...blake2b(data, { dkLen: 32 })]), keet.identityKeyPair.secretKey.subarray(0, 32));
      return new Uint8Array([1, ...epoch, ...keet.identityPublicKey, 0, 1, ...signature]);
    };
    const sdkAccepts = (proof: Uint8Array) => { try { return !!IdentityKey.verify(Buffer.from(proof), Buffer.from(data), { expectedIdentity: Buffer.from(keet.identityPublicKey) }); } catch { return false; } };
    const ours = async (proof: Uint8Array) => verifyPeerProof(await importedProof(c, proof), c).then(() => true, () => false);
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    for (const seconds of [0n, BigInt(NOW), safe / 1000n, safe / 1000n + 1n, 2n ** 52n + 1n, safe, safe + 1n, 2n ** 64n - 1n])
      expect(await ours(attest(seconds)), String(seconds)).toBe(sdkAccepts(attest(seconds)));
    expect(await ours(attest(BigInt(NOW)))).toBe(true);
    // Past 2^53 - 1 the SDK refuses to read the epoch at all.
    expect(await ours(attest(safe + 1n))).toBe(false);
  });
});
