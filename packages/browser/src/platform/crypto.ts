import * as core from "@ghostly/core";
import type * as Desktop from "../../../../src/lib/crypto";

/** Stands in for Desktop's `src/lib/crypto.ts` (Rust) with the same secretbox in TypeScript. */
export const generateEncryptionKey: typeof Desktop.generateEncryptionKey = async () =>
  core.toBase64Url(core.generateEncryptionKey());

export const encrypt: typeof Desktop.encrypt = async (plaintext, keyB64) =>
  core.encrypt(plaintext, core.fromBase64Url(keyB64));

export const decrypt: typeof Desktop.decrypt = async (encoded, keyB64) =>
  core.decrypt(encoded, core.fromBase64Url(keyB64));

export const toBase64Url: typeof Desktop.toBase64Url = async (bytes) => core.toBase64Url(bytes);
export const fromBase64Url: typeof Desktop.fromBase64Url = (str) => core.fromBase64Url(str);
