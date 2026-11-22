import { APP_BUNDLE_MAGIC, canonicalJsonBytes, utf8Encode, type AppManifest } from "@ghostly/core";

/** A bundle's signature statement: `{alg, key, sig}` with its 52-character key and 86-character signature, canonical. */
const STATEMENT_BYTES = canonicalJsonBytes({ alg: "ed25519", key: "y".repeat(52), sig: "A".repeat(86) }).length;

/**
 * The length of the whole bundle of a manifest (core's `assembleAppBundle` layout: magic, u32, the canonical manifest,
 * u32, the statement, the files): what its stored file holds once written. A shorter or longer one is not that bundle.
 */
export function bundleLength(manifest: AppManifest): number {
  return utf8Encode(APP_BUNDLE_MAGIC).length + 8 + canonicalJsonBytes(manifest).length + STATEMENT_BYTES + manifest.files.reduce((sum, f) => sum + f.size, 0);
}
