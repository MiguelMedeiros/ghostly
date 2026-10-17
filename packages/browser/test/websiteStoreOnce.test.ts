import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppBundle, seedSigner, signAppStore, toZ32, utf8Encode, type AppStoreIndex, type Signer } from "@ghostly/core";
// covers: apps.store

/*
 * ghostly.tools' /apps pages read the store the build fetched (apps/website/lib/store.ts). Its bytes cannot change while
 * the site runs, so their signatures and hashes are checked once: only whether the store is past its `expires` follows
 * the clock. Checked again every hour, the read held every request of the server for its whole run (35 ms for five
 * apps, over a second at the page's 200).
 */

const signerOf = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly website store once: ${label}`)));
const HOUR_MS = 60 * 60 * 1000;
const START_MS = 1_791_417_600_000;

// The build's snapshot (vitest.config.ts points store.ts at this fixture), filled by each test.
const snapshot = vi.hoisted(() => ({} as Record<string, unknown>));
const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock("./fixtures/website-store-snapshot.json", () => ({ default: snapshot }));
vi.mock("../../../apps/website/lib/storeRead", async (original) => {
  const real = await original<typeof import("../../../apps/website/lib/storeRead")>();
  return {
    ...real,
    // The official store's key is the app's own: these tests sign with a test key.
    STORE_KEY: toZ32(signerOf("store").publicKey),
    readStore: (...args: Parameters<typeof real.readStore>) => { reads.count++; return real.readStore(...args); },
  };
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The official store with one app, expiring `expiresInS` after the start, as sync-store.mjs writes it. */
async function writeSnapshot(expiresInS: number) {
  const publisher = signerOf("publisher");
  const made = await buildAppBundle({
    name: "chess", version: "1.0.0", sequence: 1, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact", entry: "index.html",
    permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT",
  }, [{ path: "index.html", bytes: utf8Encode("<p>chess") }], publisher);
  const url = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
  const store = signerOf("store");
  const index: AppStoreIndex = {
    ghostlyStore: 1, key: toZ32(store.publicKey), name: "Ghostly", kind: "curated", sequence: 1, expires: START_MS / 1000 + expiresInS,
    apps: [{ ref: `${toZ32(publisher.publicKey)}/chess`, sequence: 1, digest: made.digest, urls: [url], title: "Chess", tagline: "Play chess with a contact" }],
    removed: [], revoked: [],
  };
  const { indexBytes, sigBytes } = await signAppStore(index, store);
  Object.assign(snapshot, { source: "store", readAt: new Date(START_MS).toISOString(), index: b64(indexBytes), sig: b64(sigBytes), bundles: { [url]: b64(made.bytes) } });
}

async function fresh() {
  vi.resetModules();
  return import("../../../apps/website/lib/store");
}

describe("website store, read once", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    reads.count = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("checks the build's store once for the server's life, not again every hour", async () => {
    await writeSnapshot(30 * 24 * 3600);
    const { storeView, storeApp } = await fresh();
    const first = storeView();
    expect(first).toMatchObject({ ok: true, expired: false, apps: [{ name: "chess" }] });
    const slug = first.ok ? first.apps[0]!.slug : "";
    for (let hour = 1; hour <= 5; hour++) {
      vi.setSystemTime(START_MS + hour * HOUR_MS);
      expect(storeView()).toMatchObject({ ok: true, expired: false });
      expect(storeApp(slug)).toMatchObject({ name: "chess" });
    }
    expect(reads.count).toBe(1);
  });

  it("still says when the store went past its expires, without checking it again", async () => {
    await writeSnapshot(2 * 3600);
    const { storeView } = await fresh();
    expect(storeView()).toMatchObject({ ok: true, expired: false });
    vi.setSystemTime(START_MS + 3 * HOUR_MS);
    expect(storeView()).toMatchObject({ ok: true, expired: true, apps: [{ name: "chess" }] });
    expect(reads.count).toBe(1);
  });

  it("reads a store that did not check out again the next hour, as before", async () => {
    await writeSnapshot(30 * 24 * 3600);
    snapshot.sig = b64(new Uint8Array(64));
    const { storeView } = await fresh();
    expect(storeView()).toMatchObject({ ok: false });
    expect(storeView()).toMatchObject({ ok: false });
    expect(reads.count).toBe(1);
    vi.setSystemTime(START_MS + HOUR_MS);
    storeView();
    expect(reads.count).toBe(2);
  });
});
