// The official store's bytes for the /apps pages, read once when the site is built (npm run sync:references, so
// predev and prebuild too): the signed index `ghostly-store.json`, its `ghostly-store.sig`, and each listing's bundle
// from each of its URLs (at most 4, as core's index reader allows) on a host the app reads from, so a URL that holds
// another version than the listed one leaves the next to show it. Nothing is checked here: lib/storeRead.ts verifies all
// of it with the app's own readers (lib/store-core) when a page renders, and shows only what passes. The index is read
// unchecked only to know which URLs to read, within the app's bounds. Readers never call GitHub: the site serves what
// it read, icons included.
//
// Writes lib/store-snapshot.json (not committed). A failed read does not fail the build unless GHOSTLY_STORE_REQUIRED
// is set: the snapshot then says why, and the pages say the store could not be read.
//
//   GHOSTLY_STORE_FIXTURE=1 npm run sync:references     # the committed test store (e2e/fixtures/store), no network
//   GHOSTLY_STORE_REQUIRED=1 npm run sync:references    # fail when the official store cannot be read
//
// CI sets GHOSTLY_STORE_FIXTURE, so its builds never ask GitHub. The fixture's README says how it was made.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(site, "lib", "store-snapshot.json");

/** As lib/storeRead.ts holds them (packages/core/test/websiteStore.test.ts keeps the two the same). */
export const STORE_URL = "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/ghostly-store.json";
export const STORE_HOSTS = ["raw.githubusercontent.com", "cdn.jsdelivr.net"];
export const LIMITS = { indexBytes: 4 * 1024 * 1024, sigBytes: 1024, bundleBytes: 16 * 1024 * 1024, apps: 200, urls: 4, totalBytes: 64 * 1024 * 1024 };
const TIMEOUT_MS = 15_000;

export const FIXTURE_DIR = resolve(site, "e2e", "fixtures", "store");

const isFetchUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && !url.username && !url.password && STORE_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** One read, as the app makes it: no redirect, no cookie, no referrer, at most `limit` bytes. */
async function read(url, limit) {
  if (!isFetchUrl(url)) throw new Error(`not a store host: ${url}`);
  const res = await fetch(url, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`${url}: larger than ${limit} bytes`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url}: larger than ${limit} bytes`);
  return bytes;
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function fromStore() {
  const index = await read(STORE_URL, LIMITS.indexBytes);
  const sig = await read(STORE_URL.replace(/\.json$/, ".sig"), LIMITS.sigBytes);
  // Only to know which URLs to read: lib/storeRead.ts checks the index for real before it trusts any of it.
  const apps = JSON.parse(Buffer.from(index).toString("utf8")).apps;
  const listings = Array.isArray(apps) ? apps.slice(0, LIMITS.apps) : [];
  const bundles = {};
  const problems = [];
  // The index reader refuses a listing with more URLs than core allows, and with it the whole index: read no bundle.
  if (listings.some((l) => !Array.isArray(l?.urls) || l.urls.length > LIMITS.urls)) {
    problems.push(`a listing has no URLs or more than ${LIMITS.urls}: the index will not verify`);
    return { source: "store", index: b64(index), sig: b64(sig), bundles, problems };
  }
  let total = index.length + sig.length;
  for (const listing of listings) {
    for (const url of listing.urls.filter((u) => typeof u === "string" && isFetchUrl(u))) {
      if (bundles[url] !== undefined) continue;
      try {
        const bytes = await read(url, LIMITS.bundleBytes);
        if (total + bytes.length > LIMITS.totalBytes) throw new Error(`${url}: over the ${LIMITS.totalBytes} bytes all bundles may take`);
        total += bytes.length;
        bundles[url] = b64(bytes);
      } catch (error) {
        problems.push(String(error?.message ?? error));
      }
    }
  }
  return { source: "store", index: b64(index), sig: b64(sig), bundles, problems };
}

function fromFixture(dir) {
  const meta = JSON.parse(readFileSync(resolve(dir, "fixture.json"), "utf8"));
  const bundles = Object.fromEntries(Object.entries(meta.bundles).map(([url, file]) => [url, b64(readFileSync(resolve(dir, file)))]));
  return {
    source: "fixture",
    key: meta.key,
    now: meta.now,
    index: b64(readFileSync(resolve(dir, "ghostly-store.json"))),
    sig: b64(readFileSync(resolve(dir, "ghostly-store.sig"))),
    bundles,
    problems: [],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = process.env.GHOSTLY_STORE_FIXTURE;
  let snapshot;
  try {
    snapshot = fixture ? fromFixture(fixture === "1" ? FIXTURE_DIR : resolve(fixture)) : await fromStore();
  } catch (error) {
    snapshot = { source: "none", error: String(error?.message ?? error), bundles: {}, problems: [] };
  }
  writeFileSync(out, JSON.stringify({ readAt: new Date().toISOString(), ...snapshot }) + "\n");
  const count = Object.keys(snapshot.bundles).length;
  if (snapshot.source === "none" && process.env.GHOSTLY_STORE_REQUIRED) {
    console.error(`The store: not read (${snapshot.error}), and GHOSTLY_STORE_REQUIRED is set.`);
    process.exit(1);
  }
  if (snapshot.source === "none") console.warn(`The store: not read (${snapshot.error}). The /apps pages will say so.`);
  else console.log(`The store: index and ${count} bundle${count === 1 ? "" : "s"} read from the ${snapshot.source}.`);
  for (const problem of snapshot.problems) console.warn(`The store: ${problem}`);
}
