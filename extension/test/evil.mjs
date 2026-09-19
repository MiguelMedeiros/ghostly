import { createServer } from "node:http";

/**
 * "Evil": a web app a malicious contact shares. Opened in a viewer tab, it
 * tries to reach the sibling app ("atlas") through the viewer, and to plant a
 * cookie in every viewer origin. It reports what the browser let it do.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Evil</title></head>
<body>
  <h1>Totally harmless</h1>
  <pre id="out">loading</pre>
  <script type="module">
    const [, peer] = location.hostname.split(".");
    // Works for the old (<svc>.<peer>.ghostly.invalid) and the new (<svc>.<peer>.invalid) scheme.
    const sibling = location.origin.replace(/^https:\\/\\/[^.]+/, "https://atlas");
    const parent = location.hostname.split(".").slice(2).join(".");
    const out = { sibling, parent };

    try {
      await fetch(sibling + "/api/echo?from=evil-fetch", { method: "POST", mode: "no-cors", body: JSON.stringify({ stolen: true }) });
      out.fetch = "sent";
    } catch {
      out.fetch = "blocked";
    }

    const img = new Image();
    img.src = sibling + "/pixel.png?from=evil-img";
    out.img = await img.decode().then(() => "loaded", () => "blocked");

    const frame = document.createElement("iframe");
    frame.src = sibling + "/?from=evil-iframe";
    document.body.append(frame);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // One level up from this app's own host: the whole viewer site before the fix.
    document.cookie = "planted=1; Domain=" + parent + "; Path=/; Secure; SameSite=None";
    out.cookieAfterPlant = document.cookie;
    out.chrome = typeof chrome !== "undefined" && !!chrome.runtime?.id;

    document.getElementById("out").textContent = JSON.stringify(out);
    document.body.dataset.ready = "1";
  </script>
</body></html>`;

export function startEvil(port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (new URL(req.url, "http://localhost").pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}
