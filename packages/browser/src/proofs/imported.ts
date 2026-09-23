import { ed25519 } from '@noble/curves/ed25519.js';
import { importedProof, proofStatement, toZ32, utf8Encode, type ProofAdapter, type ProofChallenge, type ImportedProof } from '@ghostly/core';

type LocalAdapter = Exclude<ProofAdapter, 'nostr' | 'pubky-ring' | 'pubky-storage'>;
export interface LocalProofSigner {
  externalKey: string;
  sign(challenge: ProofChallenge): Promise<ImportedProof>;
  clear(): void;
}
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');

/** Renderer-only. No engine/RPC/storage/network API receives imported secret input.
 * Public Keypair conversion is checked with the Pubky SDK. That SDK has no raw
 * message-signing method, so standard Ed25519 signs the Ghostly statement using
 * the exact same 32-byte seed. No AuthToken, grant, login or homeserver is used. */
export async function importLocalSigner(adapter: LocalAdapter, input: string): Promise<LocalProofSigner> {
  if (adapter === 'pubky-import') {
    if (!/^[a-fA-F0-9]{64}$/.test(input)) throw new Error('Enter exactly 64 hex characters for a 32-byte Pubky secret.');
    const seed = Uint8Array.from(input.match(/../g)!, b => parseInt(b,16)); input = ''; // eslint-disable-line no-useless-assignment -- Release the caller's secret-string reference.
    try {
      const { Keypair } = await import('@synonymdev/pubky');
      const pair = Keypair.fromSecret(seed);
      let externalKey: string;
      const publicKey = pair.publicKey;
      try { externalKey = publicKey.z32(); } finally { publicKey.free(); pair.free(); }
      if (externalKey !== toZ32(ed25519.getPublicKey(seed))) throw new Error('Pubky key mismatch');
      let cleared = false;
      return { externalKey,
        async sign(c) {
          if (cleared || c.adapter !== adapter || c.externalKey !== externalKey) throw new Error('Imported key is unavailable for this proof');
          return importedProof(c, ed25519.sign(utf8Encode(proofStatement(c)),seed));
        },
        clear() { cleared = true; seed.fill(0); },
      };
    } catch { seed.fill(0); throw new Error('Could not import the Pubky key. Check the 32-byte hex format.'); }
  }
  if (adapter !== 'keet-import') throw new Error('Unsupported local key type');
  // Deliberately narrow format: SDK-generated 24-word English BIP39 mnemonic,
  // with its default empty passphrase. SDK validates checksum and derivation.
  let phrase = input.trim().toLowerCase().split(/\s+/).join(' '); input = ''; // eslint-disable-line no-useless-assignment -- Release the caller's secret-string reference.
  if (!/^[a-z]+(?: [a-z]+){23}$/.test(phrase)) throw new Error('Enter a valid 24-word Keet mnemonic (English, no extra passphrase).');
  try {
    const { default: IdentityKey } = await import('keet-identity-key');
    const identity = await IdentityKey.from({ mnemonic: phrase }); phrase = ''; 
    const externalKey = hex(identity.identityPublicKey);
    let cleared = false;
    return { externalKey,
      async sign(c) {
        if (cleared || c.adapter !== adapter || c.externalKey !== externalKey) throw new Error('Imported key is unavailable for this proof');
        // Root-only v1 DataAttestation from the official library. No assertion
        // is made that this compatible key belongs to an existing Keet account.
        return importedProof(c, IdentityKey.attestData(utf8Encode(proofStatement(c)),identity.identityKeyPair));
      },
      clear() { cleared = true; identity.keyChain.seed.fill(0); identity.clear(); },
    };
  } catch { throw new Error('Could not import the Keet mnemonic. Check its words and checksum.'); }
  finally { phrase = ''; } // eslint-disable-line no-useless-assignment -- Release the mnemonic reference.
}

/** Explicit UI test action only; never called on dialog open or auto-shared. */
export async function disposableImportSecret(adapter: LocalAdapter): Promise<string> {
  if (adapter === 'pubky-import') {
    const { Keypair } = await import('@synonymdev/pubky');
    const pair = Keypair.random(); const seed = pair.secret();
    try { return hex(seed); } finally { seed.fill(0); pair.free(); }
  }
  const { default: IdentityKey } = await import('keet-identity-key');
  return IdentityKey.generateMnemonic();
}
