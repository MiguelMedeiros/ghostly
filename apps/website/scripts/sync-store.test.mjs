import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { LIMITS, STORE_URL, fromStore } from "./sync-store.mjs";

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
