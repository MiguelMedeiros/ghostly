import { createIdentity, identityFromSeedB64 } from "@ghostly/core";
import type * as Desktop from "../../../../src/lib/pkarr";

/**
 * Stands in for Desktop's `src/lib/pkarr.ts`, which calls into Rust. Keys are
 * made here; publishing and resolving belong to the peer in the offscreen
 * document, never to a page.
 */
export const createKeypair: typeof Desktop.createKeypair = async () => {
  const identity = createIdentity();
  return { seedB64: identity.seedB64, pubKeyZ32: identity.pubKeyZ32 };
};

export const getPublicKeyFromSeed: typeof Desktop.getPublicKeyFromSeed = async (seedB64) =>
  identityFromSeedB64(seedB64).pubKeyZ32;

const notInPages = (): never => {
  throw new Error("Pkarr is handled by the Ghostly peer, not by the page");
};
export const publishMessages: typeof Desktop.publishMessages = notInPages;
export const resolveMessages: typeof Desktop.resolveMessages = notInPages;

export { fromBase64Url, toBase64Url } from "./crypto";
