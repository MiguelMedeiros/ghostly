import { readAppStore } from "./store-core/appStore";
import { APP_ICON_PATH, appViewOf, readAppBundle, type AppClient, type AppPermission, type AppViewMode } from "./store-core/appBundle";
import { appFingerprint, appRef, appRefPublisher, type SignedAppRevocation } from "./store-core/appStatements";

/*
 * The official store, as the /apps pages show it (WISP 1200 · Stores). The index, its signature and the bundles its
 * listings point at were read when the site was built (scripts/sync-store.mjs); this checks them with the app's own
 * readers (lib/store-core, copied from packages/core) and keeps only what the app would install: no other module of
 * the site reads the store's bytes. Pure, so packages/core/test/websiteStore.test.ts runs it on core's test data.
 */

/** The official store, as the app holds it: packages/browser/src/engine/appDefaults.ts (a core test keeps them equal). */
export const STORE_URL = "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/ghostly-store.json";
export const STORE_KEY = "y379ia3t1urwudj8o4w1qwmuwp1mcxyf956b5r7pqup7stce6diy";
/** Where the app reads stores and apps from (packages/browser/src/engine/appFetch.ts): nowhere else. */
export const STORE_HOSTS = ["raw.githubusercontent.com", "cdn.jsdelivr.net"] as const;
/** What the build reads, at most: the app's own bounds (appFetch.ts), and a cap on how many apps one page lists. */
export const STORE_LIMITS = { indexBytes: 4 * 1024 * 1024, sigBytes: 1024, bundleBytes: 16 * 1024 * 1024, apps: 200 } as const;

/** A URL the app would read an app from: https on one of the two hosts, no port, no user. */
export function isStoreFetchUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && (STORE_HOSTS as readonly string[]).includes(url.hostname.toLowerCase());
}

/** The bytes the build read: the index, its `.sig`, and each bundle by the URL it came from. */
export interface StoreBytes {
  index: Uint8Array;
  sig: Uint8Array;
  bundles: Record<string, Uint8Array>;
}

export interface StoreApp {
  /** `<name>.<first 16 characters of the publisher key>`: the store's folder name, the same wherever the bundle moves. */
  slug: string;
  ref: string;
  name: string;
  title: string;
  tagline: string;
  description?: string;
  category?: string;
  developer?: string;
  publisher: string;
  /** The publisher key's first 16 characters in four groups, as the app's install screen shows it. */
  fingerprint: string;
  version: string;
  sequence: number;
  digest: string;
  permissions: AppPermission[];
  clients: AppClient[];
  view: AppViewMode;
  license: string;
  homepage?: string;
  repo?: string;
  support?: string;
  releaseNotes?: string;
  /** The URL the bundle verified from: what Apps, Add takes. */
  url: string;
  /** icon.png, a square PNG the bundle reader checked, when the bundle has one. */
  icon?: Uint8Array;
}

export type StoreView =
  | {
      ok: true;
      /** The key the index is signed by. */
      key: string;
      name: string;
      description?: string;
      sequence: number;
      /** Unix seconds. Past it the app still installs and says when the store was last updated. */
      expires: number;
      expired: boolean;
      apps: StoreApp[];
      /** Listings left out, and why: a bundle that did not verify, a removed or revoked version. */
      skipped: { ref: string; reason: string }[];
    }
  | { ok: false; reason: string };

export const slugOf = (ref: string) => `${ref.slice(53)}.${appRefPublisher(ref).slice(0, 16)}`;

function revokedBy(revocations: SignedAppRevocation[], ref: string, digest: string, sequence: number): boolean {
  return revocations.some(({ statement }) =>
    statement.app === ref && ("digests" in statement ? statement.digests.includes(digest) : sequence <= statement.upTo),
  );
}

/**
 * Checks the index (size, canonical JSON, fields, revocations, the signature by `key`, `expires` at `now` seconds), then
 * each listing's bundle: read from the first of its URLs the build holds, verified by the bundle reader, and the very
 * version listed (reference, digest, sequence). A removed or revoked version is left out, as the app leaves it out.
 */
export function readStore(bytes: StoreBytes, now: number, key: string): StoreView {
  if (bytes.index.length > STORE_LIMITS.indexBytes) return { ok: false, reason: "too-large" };
  if (bytes.sig.length > STORE_LIMITS.sigBytes) return { ok: false, reason: "bad-signature-statement" };
  const read = readAppStore(bytes.index, bytes.sig, now, key);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { index, expired } = read.store;
  const apps: StoreApp[] = [];
  const skipped: { ref: string; reason: string }[] = [];
  for (const listing of index.apps) {
    const skip = (reason: string) => skipped.push({ ref: listing.ref, reason });
    if (apps.length >= STORE_LIMITS.apps) {
      skip("over-limit");
      continue;
    }
    if (index.removed.some((r) => r.ref === listing.ref && r.digest === listing.digest)) {
      skip("removed");
      continue;
    }
    if (revokedBy(index.revoked, listing.ref, listing.digest, listing.sequence)) {
      skip("revoked");
      continue;
    }
    const url = listing.urls.find((u) => isStoreFetchUrl(u) && bytes.bundles[u] !== undefined);
    if (!url) {
      skip("not-fetched");
      continue;
    }
    const bundleBytes = bytes.bundles[url];
    if (bundleBytes.length > STORE_LIMITS.bundleBytes) {
      skip("too-large");
      continue;
    }
    const bundle = readAppBundle(bundleBytes);
    if (!bundle.ok) {
      skip(bundle.reason);
      continue;
    }
    const { manifest, digest, files } = bundle.bundle;
    if (digest !== listing.digest) {
      skip("digest");
      continue;
    }
    if (appRef(manifest.publisher, manifest.name) !== listing.ref) {
      skip("ref");
      continue;
    }
    if (manifest.sequence !== listing.sequence) {
      skip("sequence");
      continue;
    }
    const icon = files.get(APP_ICON_PATH);
    apps.push({
      slug: slugOf(listing.ref),
      ref: listing.ref,
      name: manifest.name,
      // The store's words lead, as in the app's store list; the bundle's are the publisher's own.
      title: listing.title,
      tagline: listing.tagline,
      ...(manifest.description !== undefined && { description: manifest.description }),
      ...(listing.category !== undefined && { category: listing.category }),
      ...(listing.developer !== undefined && { developer: listing.developer }),
      publisher: manifest.publisher,
      fingerprint: appFingerprint(manifest.publisher),
      version: manifest.version,
      sequence: manifest.sequence,
      digest,
      permissions: [...manifest.permissions],
      clients: [...manifest.runtime.clients],
      view: appViewOf(manifest),
      license: manifest.license,
      ...(manifest.homepage !== undefined && { homepage: manifest.homepage }),
      ...(listing.repo !== undefined && { repo: listing.repo }),
      ...((listing.support ?? manifest.support) !== undefined && { support: listing.support ?? manifest.support }),
      ...(manifest.releaseNotes !== undefined && { releaseNotes: manifest.releaseNotes }),
      url,
      ...(icon && { icon: icon.slice() }),
    });
  }
  return {
    ok: true,
    key: index.key,
    name: index.name,
    ...(index.description !== undefined && { description: index.description }),
    sequence: index.sequence,
    expires: index.expires,
    expired,
    apps,
    skipped,
  };
}
