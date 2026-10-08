import snapshot from "./store-snapshot.json";
import { STORE_KEY, readStore, type StoreApp, type StoreView } from "./storeRead";

/*
 * The official store for the /apps pages: the bytes scripts/sync-store.mjs read when the site was built, checked by
 * lib/storeRead.ts with the app's own readers. Server only (the pages, the icon route, the sitemap).
 */

type Snapshot = {
  source: "store" | "fixture" | "none";
  readAt: string;
  key?: string;
  now?: number;
  index?: string;
  sig?: string;
  bundles: Record<string, string>;
  error?: string;
};

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

let memo: { hour: number; view: StoreView } | undefined;

/** The store as the build read it, checked at most once an hour (the clock matters only to `expires`). */
export function storeView(): StoreView {
  const snap = snapshot as Snapshot;
  if (snap.source === "none" || !snap.index || !snap.sig) return { ok: false, reason: snap.error ?? "not-read" };
  // The test store (e2e/fixtures/store) is signed by its own key and read at its own clock; the official one is pinned
  // to the key the app holds.
  const fixture = snap.source === "fixture";
  const now = fixture && snap.now ? snap.now : Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3600);
  if (memo?.hour === hour) return memo.view;
  const view = readStore(
    { index: bytes(snap.index), sig: bytes(snap.sig), bundles: Object.fromEntries(Object.entries(snap.bundles).map(([u, b]) => [u, bytes(b)])) },
    now,
    fixture && snap.key ? snap.key : STORE_KEY,
  );
  memo = { hour, view };
  return view;
}

/** When the build read the store: the pages say their list is as of then. */
export function storeReadAt(): number {
  const snap = snapshot as Snapshot;
  // The test store is read at its own clock.
  if (snap.source === "fixture" && snap.now) return snap.now;
  return Math.floor(Date.parse(snap.readAt) / 1000);
}

export function storeApp(slug: string): StoreApp | undefined {
  const view = storeView();
  return view.ok ? view.apps.find((a) => a.slug === slug) : undefined;
}
