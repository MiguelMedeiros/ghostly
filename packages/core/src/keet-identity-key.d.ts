/** Narrow declarations for the audited surface of keet-identity-key 3.2.0. */
declare module 'keet-identity-key' {
  export default class IdentityKey {
    static generateMnemonic(): string;
    static deriveSeed(mnemonic: string): Promise<Uint8Array>;
    static from(input: { mnemonic?: string; seed?: Uint8Array }): Promise<IdentityKey>;
    static attestData(data: Uint8Array, keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }): Uint8Array;
    static verify(proof: Uint8Array, data: Uint8Array, options: { expectedIdentity: Uint8Array }): { identityPublicKey: Uint8Array; devicePublicKey: Uint8Array } | null;
    identityPublicKey: Uint8Array;
    identityKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    keyChain: { seed: Uint8Array };
    clear(): void;
  }
}
