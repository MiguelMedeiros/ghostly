import { createServer } from "node:http";
import { createHash } from "node:crypto";

/**
 * "Atlas": a stand-in local web application for the end-to-end test. It uses
 * what real apps use: ES modules with relative imports, CSS, a binary image,
 * JSON over fetch, a redirect, in-app navigation and a large download.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const BIG = Buffer.alloc(3 * 1024 * 1024, 0).map((_, i) => (i * 31 + 7) % 256);
export const BIG_SHA256 = createHash("sha256").update(BIG).digest("hex");

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Atlas</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1 id="title">Atlas</h1>
  <img id="pixel" src="/pixel.png" alt="">
  <a id="next" href="/old">page two</a>
  <pre id="out">loading</pre>
  <script>window.inlineRan = true;</script>
  <script type="module" src="./app.js"></script>
</body></html>`;

const APP_JS = `import { sha256 } from "./lib/hash.js";
const out = {};
out.inline = window.inlineRan === true;
out.secure = window.isSecureContext;
out.css = getComputedStyle(document.getElementById("title")).color;
const echo = await fetch("/api/echo?x=1", { method: "POST", headers: { "content-type": "application/json", "x-atlas": "yes" }, body: JSON.stringify({ hello: "ghost" }) });
out.echo = await echo.json();
const big = await fetch("/big.bin");
out.bigSha = await sha256(await big.arrayBuffer());
out.missing = (await fetch("/nope")).status;
const img = document.getElementById("pixel");
await img.decode().catch(() => {});
out.image = img.naturalWidth;
localStorage.setItem("visits", String(Number(localStorage.getItem("visits") ?? 0) + 1));
out.visits = localStorage.getItem("visits");
document.getElementById("out").textContent = JSON.stringify(out);
document.body.dataset.ready = "1";
`;

const HASH_JS = `export async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}`;

export function startAtlas(port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", INDEX);
    if (url.pathname === "/style.css") return send(200, "text/css", "#title{color:rgb(1, 2, 3)}");
    if (url.pathname === "/app.js") return send(200, "text/javascript", APP_JS);
    if (url.pathname === "/lib/hash.js") return send(200, "text/javascript", HASH_JS);
    if (url.pathname === "/pixel.png") return send(200, "image/png", PNG);
    if (url.pathname === "/big.bin") return send(200, "application/octet-stream", BIG);
    if (url.pathname === "/old") return send(302, "text/plain", "moved", { location: "/page2" });
    if (url.pathname === "/page2") return send(200, "text/html", `<title>Atlas 2</title><h1 id="title">Page two</h1>`);
    if (url.pathname === "/api/echo" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () =>
        send(200, "application/json", JSON.stringify({ body: JSON.parse(Buffer.concat(chunks).toString()), query: url.search, header: req.headers["x-atlas"] })),
      );
      return;
    }
    send(404, "text/plain", "not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}
