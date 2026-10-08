// Written by apps/website/scripts/sync-store-core.mjs: the type of packages/core/src/signer.ts, which the copied readers
// name for signing. The site only reads, so it needs no signer.
export interface Signer {
  readonly publicKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
