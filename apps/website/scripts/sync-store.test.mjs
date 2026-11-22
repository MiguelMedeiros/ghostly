import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { FIXTURE_DIR, LIMITS, STORE_URL, besideUrl, fromStore, manifestDigest } from "./sync-store.mjs";

const BUNDLE = "https://raw.githubusercontent.com/ghostly-fixtures/big/HEAD/app.ghostlyapp";
/** A body six times the bundle bound, as a host that sends no content-length could. */
const SERVED = 6 * LIMITS.bundleBytes;
const CHUNK = 64 * 1024;

test("the build stops reading a bundle with no content-length once it passes the bound", async () => {
  let sent = 0;
  let closed;
  const done = new Promise((resolve) => (closed = resolve));
  const server = createServer((req, res) => {
    if (req.url === new URL(STORE_URL).pathname) {
      res.end(JSON.stringify({ apps: [{ urls: [BUNDLE] }] }));
      return;
    }
    // Read, not checked, by the build.
    if (req.url === new URL(STORE_URL.replace(/\.json$/, ".sig")).pathname) {
      res.end("{}");
      return;
    }
    if (req.url !== new URL(BUNDLE).pathname) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // Chunked, with no content-length: written only as fast as the reader takes it.
    const chunk = new Uint8Array(CHUNK);
    const write = () => {
      while (sent < SERVED) {
        sent += CHUNK;
        if (!res.write(chunk)) return void res.once("drain", write);
      }
      res.end();
    };
    res.on("close", () => closed());
    write();
  });
  server.listen(14760, "127.0.0.1");
  await once(server, "listening");
  try {
    // The store's hosts, answered by the stub on loopback.
    const fetcher = (url, init) => fetch(`http://127.0.0.1:14760${new URL(url).pathname}`, init);
    const snap = await fromStore(fetcher);
    await done;
    assert.deepEqual(snap.bundles, {});
    assert.ok(snap.problems.includes(`${BUNDLE}: larger than ${LIMITS.bundleBytes} bytes`), snap.problems.join("\n"));
    // What the sockets' buffers hold past the bound, not the whole body.
    assert.ok(sent < LIMITS.bundleBytes + 8 * 1024 * 1024, `the stub sent ${sent} of ${SERVED} bytes`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

const RAW = "https://raw.githubusercontent.com/ghostly-fixtures";
const SIG = STORE_URL.replace(/\.json$/, ".sig");
const revoke = (url) => besideUrl(url, "ghostly-revoke.json");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A store on a fake network: `served` maps a URL to its bytes (or an HTTP status), `delay` gives each URL's answer time.
 * It counts how many reads run at once.
 */
function network(listings, served, delay = () => 0) {
  const files = { [STORE_URL]: new TextEncoder().encode(JSON.stringify({ apps: listings })), [SIG]: new Uint8Array(64), ...served };
  const seen = { asked: [], inFlight: 0, most: 0 };
  const fetcher = async (url) => {
    seen.asked.push(url);
    seen.inFlight++;
    seen.most = Math.max(seen.most, seen.inFlight);
    try {
      await sleep(delay(url));
      const body = files[url];
      if (body === undefined) return new Response("Not Found", { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(body);
    } finally {
      seen.inFlight--;
    }
  };
  return { fetcher, seen };
}

test("the build reads the bundles and the revocation files a few at a time", async () => {
  const listings = Array.from({ length: 20 }, (_, i) => ({ urls: [`${RAW}/a${i}/a.ghostlyapp`, `${RAW}/b${i}/a.ghostlyapp`] }));
  const served = Object.fromEntries(listings.flatMap((l) => l.urls).map((u, i) => [u, new Uint8Array(8).fill(i)]));
  const bundles = network(listings, served, (url) => (url.endsWith(".ghostlyapp") ? 20 : 0));
  await fromStore(bundles.fetcher);
  assert.ok(bundles.seen.most > 1 && bundles.seen.most <= 8, `bundles: ${bundles.seen.most} at once`);
  const files = network(listings, served, (url) => (url.endsWith("ghostly-revoke.json") ? 20 : 0));
  const snap = await fromStore(files.fetcher);
  assert.ok(files.seen.most > 1 && files.seen.most <= 8, `revocation files: ${files.seen.most} at once`);
  assert.equal(Object.keys(snap.bundles).length, 40);
  assert.equal(files.seen.asked.filter((u) => u.endsWith("ghostly-revoke.json")).length, 40);
});

test("the build does not hold a revocation file it did not keep until a later publisher's listing reads it again", async () => {
  // Publisher A lists 96 bundle URLs, then publisher B lists the same: B reads every one of A's revocation files too.
  const urls = Array.from({ length: 96 }, (_, i) => `${RAW}/shared${i}/a.ghostlyapp`);
  const chunks = Array.from({ length: urls.length / 4 }, (_, i) => urls.slice(4 * i, 4 * i + 4));
  const listings = ["A", "B"].flatMap((p) => chunks.map((u) => ({ ref: p.repeat(52), urls: u })));
  const file = new Uint8Array(4 * 1024 * 1024);
  const { fetcher } = network(listings, Object.fromEntries(urls.map((u) => [revoke(u), file])));
  // What is still referenced, not garbage the collector has yet to free.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const held = () => (gc(), process.memoryUsage().arrayBuffers);
  const base = held();
  let most = 0;
  const snap = await fromStore(async (url, init) => {
    most = Math.max(most, held() - base);
    return fetcher(url, init);
  });
  // Each publisher keeps its share; B keeps the same files A kept.
  const share = LIMITS.revocationsTotalBytes / 2 / file.length;
  assert.deepEqual(Object.keys(snap.revocations), urls.slice(0, share).map(revoke));
  // The kept files and the reads in flight, not every file A read and did not keep (96 × 4 MiB).
  const bound = LIMITS.revocationsTotalBytes + 16 * file.length;
  assert.ok(most < bound, `held ${Math.round(most / 1048576)} MiB, more than ${bound / 1048576}`);
});

test("a listing's mirrors do not leave the listings after it without a bundle", async () => {
  const JSD = "https://cdn.jsdelivr.net/gh/ghostly-fixtures";
  const MiB = 1024 * 1024;
  // As the live store lists them: a pinned jsDelivr copy and the raw `HEAD` it mirrors. Bytes differ from app to app.
  const app = (name, size, mirrors = [`${RAW}/${name}/HEAD/a.ghostlyapp`]) => ({ name, size, urls: [`${JSD}/${name}@0123abc/a.ghostlyapp`, ...mirrors] });
  // Sorted first: a small pinned copy, then three `HEAD` URLs that now hold other bytes, as large as a bundle may be.
  const early = app("ba", 60 * 1024, [1, 2, 3].map((i) => `${RAW}/ba${i}/HEAD/a.ghostlyapp`));
  const apps = [early, app("arena", 14.1 * MiB), ...["boo-blocks", "chess", "cinema", "pkdns"].map((n) => app(n, 2 * MiB))];
  const served = {};
  apps.forEach(({ size, urls }, i) => {
    const bundle = new Uint8Array(Math.round(size)).fill(i + 1);
    urls.forEach((url, j) => (served[url] = i === 0 && j > 0 ? new Uint8Array(LIMITS.bundleBytes).fill(100 + j) : bundle));
  });
  const { fetcher } = network(apps.map(({ urls }) => ({ urls })), served);
  const snap = await fromStore(fetcher);
  for (const { urls } of apps.slice(1)) {
    assert.ok(urls[0] in snap.bundles, `${urls[0]} not kept:\n${snap.problems.join("\n")}`);
    // The same bytes at the raw `HEAD` are kept once, and take nothing more from the budget.
    assert.equal(snap.sameAs?.[urls[1]], urls[0], `${urls[1]} not kept:\n${snap.problems.join("\n")}`);
  }
  // What is over the budget is the early listing's own last mirror.
  assert.deepEqual(snap.problems, [`${early.urls[3]}: over the ${LIMITS.totalBytes} bytes all bundles may take`]);
});

test("a listing's jsDelivr mirrors do not leave a listing after it with only a raw URL without a bundle", async () => {
  const MiB = 1024 * 1024;
  const first = [1, 2, 3].map((i) => `https://cdn.jsdelivr.net/gh/x/a${i}@0123abc/a.ghostlyapp`);
  const pinned = "https://cdn.jsdelivr.net/gh/x/p@0123abc/a.ghostlyapp";
  const rawOnly = `${RAW}/b/HEAD/a.ghostlyapp`;
  const served = Object.fromEntries(first.map((u, i) => [u, new Uint8Array(LIMITS.bundleBytes).fill(i + 1)]));
  served[pinned] = new Uint8Array(15 * MiB).fill(10);
  served[rawOnly] = new Uint8Array(2 * MiB).fill(11);
  const { fetcher } = network([{ urls: first }, { urls: [pinned] }, { urls: [rawOnly] }], served);
  const snap = await fromStore(fetcher);
  assert.deepEqual(Object.keys(snap.bundles), [first[0], pinned, rawOnly, first[1]]);
  assert.deepEqual(snap.problems, [`${first[2]}: over the ${LIMITS.totalBytes} bytes all bundles may take`]);
});

test("a listing that names its raw `HEAD` before its jsDelivr copy still has the jsDelivr copy read first", async () => {
  const MiB = 1024 * 1024;
  const others = [1, 2, 3].map((i) => `https://cdn.jsdelivr.net/gh/x/o${i}@0123abc/a.ghostlyapp`);
  const raw = `${RAW}/x/HEAD/a.ghostlyapp`;
  const pinned = "https://cdn.jsdelivr.net/gh/x/x@0123abc/a.ghostlyapp";
  const served = Object.fromEntries(others.map((u, i) => [u, new Uint8Array(LIMITS.bundleBytes).fill(i + 1)]));
  // `HEAD` moved on to other bytes after review; the pinned copy is the version the store listed.
  served[raw] = new Uint8Array(15 * MiB).fill(20);
  served[pinned] = new Uint8Array(10 * MiB).fill(21);
  const { fetcher } = network([...others.map((u) => ({ urls: [u] })), { urls: [raw, pinned] }], served);
  const snap = await fromStore(fetcher);
  assert.ok(pinned in snap.bundles, snap.problems.join("\n"));
  assert.deepEqual(snap.problems, [`${raw}: over the ${LIMITS.totalBytes} bytes all bundles may take`]);
});

test("reads that finish out of order keep the list's order, its byte budget and its problems as one read at a time does", async () => {
  const big = (n) => new Uint8Array(LIMITS.bundleBytes).fill(n);
  // Read one URL of each listing at a time (bundleOrder): one, three, two, four, broken, small. Three full bundles and
  // the index take all but a few bytes of the budget: the fourth is over it, the small one after is not.
  const urls = ["one", "two", "broken", "three", "four", "small"].map((n) => `${RAW}/${n}/a.ghostlyapp`);
  const listings = [{ urls: urls.slice(0, 3) }, { urls: urls.slice(3) }];
  const served = { [urls[0]]: big(1), [urls[1]]: big(2), [urls[2]]: 500, [urls[3]]: big(3), [urls[4]]: big(4), [urls[5]]: new Uint8Array(8) };
  served[revoke(urls[1])] = 503;
  served[revoke(urls[4])] = 502;
  // The later a URL is listed, the sooner it answers.
  const order = [...urls, ...urls.map(revoke)];
  const { fetcher } = network(listings, served, (url) => 5 * (order.length - order.indexOf(url)));
  const snap = await fromStore(fetcher);
  assert.deepEqual(Object.keys(snap.bundles), [urls[0], urls[3], urls[1], urls[5]]);
  assert.deepEqual(snap.problems, [
    `${urls[4]}: over the ${LIMITS.totalBytes} bytes all bundles may take`,
    `${urls[2]}: HTTP 500`,
    `${revoke(urls[1])}: HTTP 503`,
    `${revoke(urls[4])}: HTTP 502`,
  ]);
});

/** Bundle-shaped bytes, `size` long: the magic, the manifest's length and bytes, then filler the build does not read. */
function bundleOf(manifest, size) {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("GHOSTLYAPP1"));
  new DataView(bytes.buffer).setUint32(11, json.length);
  bytes.set(json, 15);
  return { bytes, digest: createHash("sha256").update(json).digest("base64url") };
}

test("a raw `HEAD` that moved on to another version takes none of the budget a later listing's raw URL needs", async () => {
  const MiB = 1024 * 1024;
  const JSD = "https://cdn.jsdelivr.net/gh/ghostly-fixtures";
  const served = {};
  // Four listings whose pinned copies hold the listed version, and whose raw `HEAD` holds a later one, as large as a
  // bundle may be.
  const early = ["a", "b", "c", "d"].map((name) => {
    const listed = bundleOf({ name, sequence: 1 }, 64 * 1024);
    const urls = [`${JSD}/${name}@0123abc/a.ghostlyapp`, `${RAW}/${name}/HEAD/a.ghostlyapp`];
    served[urls[0]] = listed.bytes;
    served[urls[1]] = bundleOf({ name, sequence: 2 }, LIMITS.bundleBytes).bytes;
    return { digest: listed.digest, urls };
  });
  // A later listing whose jsDelivr copy fails while the site is built: its raw URL holds the listed version.
  const later = bundleOf({ name: "later", sequence: 1 }, 2 * MiB);
  const laterUrls = [`${JSD}/later@0123abc/a.ghostlyapp`, `${RAW}/later/HEAD/a.ghostlyapp`];
  served[laterUrls[0]] = 503;
  served[laterUrls[1]] = later.bytes;
  const { fetcher } = network([...early, { digest: later.digest, urls: laterUrls }], served);
  const snap = await fromStore(fetcher);
  assert.ok(laterUrls[1] in snap.bundles, snap.problems.join("\n"));
  assert.deepEqual(Object.keys(snap.bundles), [...early.map(({ urls }) => urls[0]), laterUrls[1]]);
  assert.deepEqual(snap.problems, [
    `${laterUrls[0]}: HTTP 503`,
    ...early.map(({ urls }) => `${urls[1]}: not the version its listing names`),
  ]);
});

test("the build reads a bundle's digest as core names it", () => {
  const meta = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "fixture.json"), "utf8"));
  const { apps } = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "ghostly-store.json"), "utf8"));
  const matches = apps.flatMap((app) => app.urls.map((url) => [url, manifestDigest(readFileSync(resolve(FIXTURE_DIR, meta.bundles[url]))) === app.digest]));
  // `older` serves another version than its listing names (its README); every other fixture bundle is the listed one.
  assert.deepEqual(matches, matches.map(([url]) => [url, !url.includes("/older/")]));
});
