import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { LIMITS, STORE_URL, besideUrl, fromStore } from "./sync-store.mjs";

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
  const served = Object.fromEntries(listings.flatMap((l) => l.urls).map((u) => [u, new Uint8Array(8)]));
  const bundles = network(listings, served, (url) => (url.endsWith(".ghostlyapp") ? 20 : 0));
  await fromStore(bundles.fetcher);
  assert.ok(bundles.seen.most > 1 && bundles.seen.most <= 8, `bundles: ${bundles.seen.most} at once`);
  const files = network(listings, served, (url) => (url.endsWith("ghostly-revoke.json") ? 20 : 0));
  const snap = await fromStore(files.fetcher);
  assert.ok(files.seen.most > 1 && files.seen.most <= 8, `revocation files: ${files.seen.most} at once`);
  assert.equal(Object.keys(snap.bundles).length, 40);
  assert.equal(files.seen.asked.filter((u) => u.endsWith("ghostly-revoke.json")).length, 40);
});

test("reads that finish out of order keep the list's order, its byte budget and its problems as one read at a time does", async () => {
  const big = new Uint8Array(LIMITS.bundleBytes);
  // Three full bundles and the index take all but a few bytes of the budget: the fourth is over it, the small one after is not.
  const urls = ["one", "two", "broken", "three", "four", "small"].map((n) => `${RAW}/${n}/a.ghostlyapp`);
  const listings = [{ urls: urls.slice(0, 3) }, { urls: urls.slice(3) }];
  const served = { [urls[0]]: big, [urls[1]]: big, [urls[2]]: 500, [urls[3]]: big, [urls[4]]: big, [urls[5]]: new Uint8Array(8) };
  served[revoke(urls[1])] = 503;
  served[revoke(urls[4])] = 502;
  // The later a URL is listed, the sooner it answers.
  const order = [...urls, ...urls.map(revoke)];
  const { fetcher } = network(listings, served, (url) => 5 * (order.length - order.indexOf(url)));
  const snap = await fromStore(fetcher);
  assert.deepEqual(Object.keys(snap.bundles), [urls[0], urls[1], urls[3], urls[5]]);
  assert.deepEqual(snap.problems, [
    `${urls[2]}: HTTP 500`,
    `${urls[4]}: over the ${LIMITS.totalBytes} bytes all bundles may take`,
    `${revoke(urls[1])}: HTTP 503`,
    `${revoke(urls[4])}: HTTP 502`,
  ]);
});
