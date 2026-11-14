/**
 * What the Bitcoin descriptor libraries (`@bitcoinerlab/descriptors-*`, the Ark wallet's) take from noble's
 * secp256k1. They are CommonJS: a `require()` of noble's module hands them all of it, so a browser build kept every
 * export, FROST threshold signing among them, in the shared secp256k1 chunk of the first load. The browser builds
 * swap their `require()` for this module (packages/browser/vite-plugin.ts), and the rest of noble's stays shakeable.
 */
export { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
