import { importedProof, proofStatement, utf8Encode, type ProofAdapter, type ProofChallenge, type ImportedProof } from '@ghostly/core';

type LocalAdapter = Exclude<ProofAdapter, 'nostr' | 'pubky-ring' | 'pubky-storage'>;
export interface LocalProofSigner {
  externalKey: string;
  sign(challenge: ProofChallenge): Promise<ImportedProof>;
  clear(): void;
}
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');

/** Renderer-only. No engine/RPC/storage/network API receives imported secret input.
 * Keet only: a pasted Pubky secret is retired (`pubky-import` evidence already given still verifies). */
export async function importLocalSigner(adapter: LocalAdapter, input: string): Promise<LocalProofSigner> {
  // A pasted Pubky secret is retired: Pubky identities are approved in Pubky Ring or Passport (WISP 302).
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
  if (adapter !== 'keet-import') throw new Error('Unsupported local key type');
  const { default: IdentityKey } = await import('keet-identity-key');
  return IdentityKey.generateMnemonic();
}
