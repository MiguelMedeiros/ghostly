import type { NativeEndpoint } from "@ghostly/core";

/** Largest frame a channel carries, in bytes. */
export const MAX_FRAME: number;

/** A HyperDHT endpoint for one chat (WISP 103): native UDP and NoiseSecretStream, keyed by the 32-byte seed. */
export function createHyperEndpoint(seed: Uint8Array, options?: { bootstrap?: string[]; host?: string }): Promise<NativeEndpoint>;
