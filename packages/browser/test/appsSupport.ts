import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildAppBundle, seedSigner, signAppRevocation, signAppStore, toZ32, utf8Encode,
  type AppListing, type AppManifestDraft, type AppPermission, type AppRemoval, type AppStoreIndex, type AppViewMode, type SignedAppRevocation, type Signer,
} from "@ghostly/core";
import { vi } from "vitest";
import { STORES, wrap } from "../src/shared/idb";
import { resetFileBytes } from "../src/shared/fileBytes";
import { Apps, type AppsHost } from "../src/engine/apps";
import { boundedAppFetch } from "../src/engine/appFetch";

/*
 * What the engine's app store tests share: test keys from fixed labels (never real keys), bundles and store indexes
 * built and signed with the core library, and a network that answers only the URLs a test put on it and counts every
 * request.
 */

/** The tests' clock: the apps vectors' `now` (WISP 1200 § Test vectors), in ms. */
export const NOW_MS = 1_790_000_000_000;
export const NOW_S = NOW_MS / 1000;

export const signer = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly apps engine tests: ${label}`)));
export const keyOf = (s: Signer) => toZ32(s.publicKey);

export const PUBLISHER = signer("publisher");
export const STORE_KEY = signer("store");
export const REPO = "https://raw.githubusercontent.com/ana/chess/HEAD";
export const BUNDLE_URL = `${REPO}/app.ghostlyapp`;
export const STORE_URL = "https://raw.githubusercontent.com/ghostly/store/HEAD/ghostly-store.json";
export const SIG_URL = "https://raw.githubusercontent.com/ghostly/store/HEAD/ghostly-store.sig";
export const PINNED_URL = `https://cdn.jsdelivr.net/gh/ana/chess@${"a".repeat(40)}/app.ghostlyapp`;

export interface Built { bytes: Uint8Array; digest: string; ref: string; sequence: number }

export async function bundle(options: { sequence?: number; version?: string; permissions?: AppPermission[]; entry?: string; sources?: string[]; by?: Signer; name?: string; view?: AppViewMode } = {}): Promise<Built> {
  const sequence = options.sequence ?? 1;
  const draft: AppManifestDraft = {
    name: options.name ?? "chess", version: options.version ?? `1.0.${sequence}`, sequence, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: options.permissions ?? ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT",
    ...(options.sources && { sources: options.sources }),
    ...(options.view && { view: options.view }),
  };
  const files = [{ path: "index.html", bytes: utf8Encode(options.entry ?? `<!doctype html><title>Chess</title><p>v${sequence}`) }, { path: "data/openings.json", bytes: utf8Encode("[]") }];
  const by = options.by ?? PUBLISHER;
  const made = await buildAppBundle(draft, files, by);
  return { bytes: made.bytes, digest: made.digest, ref: `${keyOf(by)}/${draft.name}`, sequence };
}

export const listing = (b: Built, urls = [BUNDLE_URL]): AppListing => ({ ref: b.ref, sequence: b.sequence, digest: b.digest, urls, title: "Chess", tagline: "Play chess with a contact" });

export async function storeFiles(options: { sequence?: number; apps?: AppListing[]; removed?: AppRemoval[]; revoked?: SignedAppRevocation[]; expires?: number; by?: Signer; kind?: "curated" | "indexed"; name?: string } = {}) {
  const by = options.by ?? STORE_KEY;
  const index: AppStoreIndex = {
    ghostlyStore: 1, key: keyOf(by), name: options.name ?? "Test store", kind: options.kind ?? "curated", sequence: options.sequence ?? 1,
    expires: options.expires ?? NOW_S + 30 * 24 * 3600, apps: options.apps ?? [], removed: options.removed ?? [], revoked: options.revoked ?? [],
  };
  return signAppStore(index, by);
}

export const revocation = (ref: string, digests: string[], reason = "Leaked key") => signAppRevocation({ ghostlyRevoke: 1, app: ref, digests, reason }, PUBLISHER);

/** A network that answers the URLs put on it, 404 for the rest, and records every request. */
export class FakeNet {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: string[] = [];
  readonly fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    this.requests.push(url);
    const body = this.files.get(url);
    return body ? new Response(body.slice(), { status: 200 }) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  put(url: string, bytes: Uint8Array): void { this.files.set(url, bytes); }
  async putStore(files: { indexBytes: Uint8Array; sigBytes: Uint8Array }, url = STORE_URL): Promise<void> {
    this.put(url, files.indexBytes);
    this.put(new URL("ghostly-store.sig", url).href, files.sigBytes);
  }
}

/** Every database gone, file storage in IndexedDB pieces: each test starts with an empty profile. */
export async function emptyProfile(): Promise<void> {
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  resetFileBytes(["idb"]);
}

export function apps(net: FakeNet, host: Partial<AppsHost> = {}): Apps {
  return new Apps({ fetch: boundedAppFetch({ fetcher: net.fetch }), isChat: (scope) => scope === "chat-1" || scope === "chat-2", online: () => true, now: () => NOW_MS, defaults: [], ...host });
}

export async function rows(name: string): Promise<unknown[]> {
  const { openDb } = await import("../src/shared/idb");
  return wrap((await openDb()).transaction(name, "readonly").objectStore(name).getAll());
}
export const appRows = () => rows(STORES.apps);
export const storageRows = () => rows(STORES.appStorage);
/** Bundle ids in file storage (pieces in IndexedDB in these tests). */
export async function bundleIds(): Promise<string[]> {
  const pieces = await rows(STORES.fileChunks) as { id: string }[];
  return [...new Set(pieces.map((p) => p.id))].filter((id) => id.startsWith("app-")).sort();
}
