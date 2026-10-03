import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The Android app's manifest (docs/ANDROID.md): its package name and the certificates it is signed with. */
const TWA_MANIFEST = fileURLToPath(new URL("../android-twa/twa-manifest.json", import.meta.url));

/** A SHA-256 certificate fingerprint as keytool and Bubblewrap print it: 32 pairs of upper-case hex, colon-separated. */
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/**
 * `/.well-known/assetlinks.json`, the Digital Asset Links statement that lets the Android app open this site
 * without a URL bar: the site vouches for the app's package signed with these certificates. Read from the
 * TWA manifest's `fingerprints`, so the package name and the keys cannot drift apart. None yet (the signing key is
 * made once, by hand): no file at all, rather than a statement for a placeholder.
 */
export function assetLinks(twaManifest: { packageId?: unknown; fingerprints?: unknown }): string | null {
  const { packageId, fingerprints = [] } = twaManifest;
  if (typeof packageId !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageId)) {
    throw new Error(`twa-manifest.json: packageId ${JSON.stringify(packageId)} is not an Android package name`);
  }
  if (!Array.isArray(fingerprints)) throw new Error("twa-manifest.json: fingerprints is not a list");
  const values = fingerprints.map((entry) => (typeof entry === "object" && entry !== null ? (entry as { value?: unknown }).value : entry));
  for (const value of values) {
    if (typeof value !== "string" || !FINGERPRINT.test(value)) {
      throw new Error(`twa-manifest.json: ${JSON.stringify(value)} is not a SHA-256 fingerprint (AA:BB:...: 32 pairs)`);
    }
  }
  if (values.length === 0) return null;
  const statement = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: packageId, sha256_cert_fingerprints: values },
    },
  ];
  return JSON.stringify(statement, null, 2) + "\n";
}

export function assetLinksFile(manifestPath = TWA_MANIFEST): Plugin {
  return {
    name: "ghostly-asset-links",
    apply: "build",
    generateBundle() {
      const body = assetLinks(JSON.parse(readFileSync(manifestPath, "utf8")));
      if (body) this.emitFile({ type: "asset", fileName: ".well-known/assetlinks.json", source: body });
    },
  };
}
