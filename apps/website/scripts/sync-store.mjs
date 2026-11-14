// The official store's bytes for the /apps pages, read once when the site is built (npm run sync:references, so
// predev and prebuild too): the signed index `ghostly-store.json`, its `ghostly-store.sig`, and each listing's bundle
// from each of its URLs (at most 4, as core's index reader allows) on a host the app reads from, so a URL that holds
// another version than the listed one leaves the next to show it. Then each publisher's own `ghostly-revoke.json`, beside
// each of those URLs and beside each `sources` URL its bundles' manifests name, as the app reads them before Install
// (packages/browser/src/engine/apps.ts, readRevocations): a version its publisher revoked is left out before the store
// copies the revocation into its index. Nothing is checked here: lib/storeRead.ts verifies all
// of it with the app's own readers (lib/store-core) when a page renders, and shows only what passes. The index is read
// unchecked only to know which URLs to read, within the app's bounds. Readers never call GitHub: the site serves what
// it read, icons included.
//
// Writes lib/store-snapshot.json (not committed): `revocations` holds each revocation file read, by its own URL (an
// older snapshot has none, which revokes nothing). A failed read does not fail the build unless GHOSTLY_STORE_REQUIRED
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
export const LIMITS = {
  indexBytes: 4 * 1024 * 1024, sigBytes: 1024, bundleBytes: 16 * 1024 * 1024, apps: 200, urls: 4, totalBytes: 64 * 1024 * 1024,
  /**
   * One `ghostly-revoke.json`, as the app bounds it (appFetch.ts), and every one the listings of one publisher read: a
   * bound of each, so one publisher's files never leave another's unread (a file not kept revokes nothing). All of them
   * together stay under `revocationsTotalBytes`, an even share each (the snapshot is one JSON string the build imports).
   */
  revocationsBytes: 16 * 1024 * 1024, revocationsPublisherBytes: 64 * 1024 * 1024, revocationsTotalBytes: 64 * 1024 * 1024,
  /** The `sources` one manifest may name (core's appBundle.ts). */
  sources: 8,
};
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
async function read(url, limit, fetcher = fetch) {
  if (!isFetchUrl(url)) throw new Error(`not a store host: ${url}`);
  const res = await fetcher(url, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) throw Object.assign(new Error(`${url}: HTTP 404`), { missing: true });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tooLarge = () => new Error(`${url}: larger than ${limit} bytes`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array();
  // A body with no length (or one fetch unpacks) is read only up to the limit, not whole and then refused.
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** How many reads the build makes at once. */
const READS_AT_ONCE = 8;

/**
 * Reads `urls`, at most READS_AT_ONCE at a time, and hands each to `take(url, bytes, error)` in the list's order, so the
 * byte budgets `take` keeps and the problems it writes come out as one read at a time gives them. A read starts only
 * when the one READS_AT_ONCE places before it was taken: no more than READS_AT_ONCE answers are held at once.
 */
async function readInOrder(urls, limit, fetcher, take) {
  const settle = (url) => read(url, limit, fetcher).then((bytes) => ({ bytes }), (error) => ({ error }));
  const pending = [];
  let next = 0;
  for (let taken = 0; taken < urls.length; taken++) {
    while (next < urls.length && pending.length < READS_AT_ONCE) pending.push(settle(urls[next++]));
    const { bytes, error } = await pending.shift();
    await take(urls[taken], bytes, error);
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/** A file beside another, as the app names it (packages/browser/src/engine/appFetch.ts, besideUrl). */
export function besideUrl(url, name) {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  return new URL(name, target).href;
}

const MAGIC = "GHOSTLYAPP1";

/**
 * The `sources` a bundle's manifest names, read unchecked (only to know which revocation files to read: lib/storeRead.ts
 * takes them from the bundle it verified): "GHOSTLYAPP1", a 32-bit big-endian length, then the manifest's JSON.
 */
export function manifestSources(bytes) {
  try {
    if (bytes.length < MAGIC.length + 4 || Buffer.from(bytes.subarray(0, MAGIC.length)).toString("latin1") !== MAGIC) return [];
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length);
    const start = MAGIC.length + 4;
    if (start + length > bytes.length) return [];
    const sources = JSON.parse(Buffer.from(bytes.subarray(start, start + length)).toString("utf8"))?.sources;
    return Array.isArray(sources) ? sources.slice(0, LIMITS.sources).filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** Where the app reads a listing's revocations: beside each of its URLs and each source its bundles name, on the app's hosts. */
export function revocationUrls(listing, bundles) {
  const urls = listing.urls.filter((u) => typeof u === "string" && isFetchUrl(u));
  const sources = urls.flatMap((u) => (bundles.has(u) ? manifestSources(bundles.get(u)) : []));
  return [...new Set([...urls, ...sources].filter(isFetchUrl).map((u) => besideUrl(u, "ghostly-revoke.json")))];
}

/**
 * Reads the official store and everything its pages show, with `fetcher` (the network's `fetch` unless a test gives its
 * own). A revocation file that is not there is no problem: most publishers have none.
 */
export async function fromStore(fetcher = fetch) {
  const index = await read(STORE_URL, LIMITS.indexBytes, fetcher);
  const sig = await read(STORE_URL.replace(/\.json$/, ".sig"), LIMITS.sigBytes, fetcher);
  // Only to know which URLs to read: lib/storeRead.ts checks the index for real before it trusts any of it.
  const apps = JSON.parse(Buffer.from(index).toString("utf8")).apps;
  const listings = Array.isArray(apps) ? apps.slice(0, LIMITS.apps) : [];
  const bundles = {};
  const revocations = {};
  const problems = [];
  // The index reader refuses a listing with more URLs than core allows, and with it the whole index: read no bundle.
  if (listings.some((l) => !Array.isArray(l?.urls) || l.urls.length > LIMITS.urls)) {
    problems.push(`a listing has no URLs or more than ${LIMITS.urls}: the index will not verify`);
    return { source: "store", index: b64(index), sig: b64(sig), bundles, revocations, problems };
  }
  const readBundles = new Map();
  let total = index.length + sig.length;
  const bundleUrls = new Set(listings.flatMap((listing) => listing.urls.filter((u) => typeof u === "string" && isFetchUrl(u))));
  await readInOrder([...bundleUrls], LIMITS.bundleBytes, fetcher, (url, bytes, error) => {
    try {
      if (error) throw error;
      if (total + bytes.length > LIMITS.totalBytes) throw new Error(`${url}: over the ${LIMITS.totalBytes} bytes all bundles may take`);
      total += bytes.length;
      bundles[url] = b64(bytes);
      readBundles.set(url, bytes);
    } catch (error) {
      problems.push(String(error?.message ?? error));
    }
  });
  // By publisher (the reference's key, as core's appRefPublisher reads it): the URLs its listings read, and their bytes.
  const publishers = new Map();
  const failed = new Set();
  const keyOf = (listing) => (typeof listing.ref === "string" ? listing.ref.slice(0, 52) : "");
  for (const listing of listings) publishers.set(keyOf(listing), { urls: new Set(), bytes: 0 });
  const share = Math.min(LIMITS.revocationsPublisherBytes, Math.floor(LIMITS.revocationsTotalBytes / Math.max(1, publishers.size)));
  // Each publisher's files in its listings' order; a file read once, then judged for every publisher that reads it.
  const uses = [];
  for (const listing of listings) {
    const publisher = publishers.get(keyOf(listing));
    for (const url of revocationUrls(listing, readBundles)) {
      if (publisher.urls.has(url)) continue;
      publisher.urls.add(url);
      uses.push({ publisher, url });
    }
  }
  const lastUse = new Map(uses.map(({ url }, i) => [url, i]));
  const answers = new Map();
  let judged = 0;
  const judge = ({ publisher, url }, { bytes, error }) => {
    if (error) {
      if (!failed.has(url) && !error?.missing) problems.push(String(error?.message ?? error));
      failed.add(url);
      return;
    }
    // Over this publisher's bound, the file is not kept for it; another publisher whose listings read it still may.
    if (publisher.bytes + bytes.length > share) {
      problems.push(`${url}: over the ${share} bytes one publisher's revocation files may take`);
      return;
    }
    publisher.bytes += bytes.length;
    revocations[url] = b64(bytes);
  };
  // A file's first use comes in the order its read does, so every use before the next unread file can be judged now.
  await readInOrder([...new Set(uses.map(({ url }) => url))], LIMITS.revocationsBytes, fetcher, async (url, bytes, error) => {
    answers.set(url, { bytes, error });
    for (; judged < uses.length && answers.has(uses[judged].url); judged++) {
      const use = uses[judged];
      // A file no publisher kept is not held for a later one (that would hold every file read): it is read again.
      const answer = answers.get(use.url) ?? (await read(use.url, LIMITS.revocationsBytes, fetcher).then((bytes) => ({ bytes }), (error) => ({ error })));
      judge(use, answer);
      if (lastUse.get(use.url) === judged) answers.delete(use.url);
      else answers.set(use.url, answer.bytes && revocations[use.url] === undefined ? null : answer);
    }
  });
  return { source: "store", index: b64(index), sig: b64(sig), bundles, revocations, problems };
}

function fromFixture(dir) {
  const meta = JSON.parse(readFileSync(resolve(dir, "fixture.json"), "utf8"));
  const bundles = Object.fromEntries(Object.entries(meta.bundles).map(([url, file]) => [url, b64(readFileSync(resolve(dir, file)))]));
  const revocations = Object.fromEntries(Object.entries(meta.revocations ?? {}).map(([url, file]) => [url, b64(readFileSync(resolve(dir, file)))]));
  return {
    source: "fixture",
    key: meta.key,
    now: meta.now,
    index: b64(readFileSync(resolve(dir, "ghostly-store.json"))),
    sig: b64(readFileSync(resolve(dir, "ghostly-store.sig"))),
    bundles,
    revocations,
    problems: [],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = process.env.GHOSTLY_STORE_FIXTURE;
  let snapshot;
  try {
    snapshot = fixture ? fromFixture(fixture === "1" ? FIXTURE_DIR : resolve(fixture)) : await fromStore();
  } catch (error) {
    snapshot = { source: "none", error: String(error?.message ?? error), bundles: {}, revocations: {}, problems: [] };
  }
  writeFileSync(out, JSON.stringify({ readAt: new Date().toISOString(), ...snapshot }) + "\n");
  const count = Object.keys(snapshot.bundles).length;
  if (snapshot.source === "none" && process.env.GHOSTLY_STORE_REQUIRED) {
    console.error(`The store: not read (${snapshot.error}), and GHOSTLY_STORE_REQUIRED is set.`);
    process.exit(1);
  }
  if (snapshot.source === "none") console.warn(`The store: not read (${snapshot.error}). The /apps pages will say so.`);
  else {
    const revoke = Object.keys(snapshot.revocations).length;
    console.log(`The store: index, ${count} bundle${count === 1 ? "" : "s"} and ${revoke} revocation file${revoke === 1 ? "" : "s"} read from the ${snapshot.source}.`);
  }
  for (const problem of snapshot.problems) console.warn(`The store: ${problem}`);
}
