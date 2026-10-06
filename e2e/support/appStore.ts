/**
 * A store and an app for the Apps page's specs (WISP 1200 § Stores, § Apps sent in a chat), built and signed in the
 * test process with the core library under test keys (the SHA-256 of a fixed label, never a real key), and served at
 * `raw.githubusercontent.com` URLs by `context.route`: nothing leaves the machine, and each context counts what it asked.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { BrowserContext } from "@playwright/test";
import { buildAppBundle, seedSigner, signAppStore, toZ32, utf8Encode, type AppStoreIndex, type Signer } from "@ghostly/core";

const signer = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly apps e2e: ${label}`)));

export const STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
export const APP_URL = "https://raw.githubusercontent.com/ghostly-e2e/chess/HEAD/app.ghostlyapp";

export interface TestStore {
  /** Every file by URL. */
  files: Map<string, Uint8Array>;
  ref: string;
  title: string;
  storeName: string;
}

/** A curated store listing one app, "Chess", that asks for `chat`. */
export async function testStore(): Promise<TestStore> {
  const publisher = signer("publisher"), store = signer("store");
  const title = "Chess", storeName = "E2E store";
  const entry = `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px system-ui"><h1>${title}</h1>`;
  const made = await buildAppBundle({
    name: "chess", version: "1.2.0", sequence: 1, kind: "mini-app", title, tagline: "Play chess with a contact",
    description: "Chess for two, move by move, in your chat.", entry: "index.html", permissions: ["chat"],
    runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT",
  }, [{ path: "index.html", bytes: utf8Encode(entry) }], publisher);
  const ref = `${toZ32(publisher.publicKey)}/chess`;
  const index: AppStoreIndex = {
    ghostlyStore: 1, key: toZ32(store.publicKey), name: storeName, description: "Apps for the end-to-end tests.", kind: "curated", sequence: 1,
    expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, removed: [], revoked: [],
    apps: [{ ref, sequence: 1, digest: made.digest, urls: [APP_URL], title, tagline: "Play chess with a contact", category: "games" }],
  };
  const signed = await signAppStore(index, store);
  const files = new Map<string, Uint8Array>([
    [APP_URL, made.bytes],
    [STORE_URL, signed.indexBytes],
    [new URL("ghostly-store.sig", STORE_URL).href, signed.sigBytes],
  ]);
  return { files, ref, title, storeName };
}

/** Serves the store's files from GitHub's raw host in `context` (404 for the rest of it); returns what it asked, in order. */
export async function serveStore(context: BrowserContext, store: TestStore): Promise<string[]> {
  const asked: string[] = [];
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|cdn\.jsdelivr\.net)\//, (route) => {
    const url = route.request().url();
    asked.push(url);
    const body = store.files.get(url.split(/[?#]/)[0]!);
    return route.fulfill(body
      ? { status: 200, contentType: "application/octet-stream", headers: { "access-control-allow-origin": "*" }, body: Buffer.from(body) }
      : { status: 404, headers: { "access-control-allow-origin": "*" }, body: "404: Not Found" });
  });
  return asked;
}
