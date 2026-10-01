// "Lake photos": a small web app on Boo's computer for the services shots, the kind of thing a
// person runs locally (a photo gallery). Plain HTTP on 127.0.0.1, inline pictures, nothing fetched
// from anywhere else.
import { createServer } from "node:http";

const PHOTOS: readonly [title: string, from: string, to: string, glyph: string][] = [
  ["The old house", "#1b1440", "#6b3a5b", "🏚️"],
  ["Moonrise", "#0f172a", "#334155", "🌕"],
  ["Canoe at dawn", "#0c4a6e", "#f59e0b", "🛶"],
  ["Campfire", "#1c1917", "#ea580c", "🔥"],
  ["Night swim", "#082f49", "#0e7490", "🌊"],
  ["The gang", "#312e81", "#a21caf", "👻"],
];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lake photos</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.4 system-ui, -apple-system, sans-serif; background: #0b1020; color: #e2e8f0; }
  header { padding: 28px 32px 8px; }
  h1 { margin: 0; font-size: 26px; }
  p { margin: 4px 0 0; color: #94a3b8; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; padding: 20px 32px 32px; }
  figure { margin: 0; border-radius: 14px; overflow: hidden; background: #111827; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
  .pic { aspect-ratio: 4 / 3; display: grid; place-items: center; font-size: 64px; }
  figcaption { padding: 10px 14px; font-size: 14px; color: #cbd5e1; }
</style></head>
<body data-ready="1">
  <header><h1>Lake photos</h1><p>Saturday at the lake house · ${PHOTOS.length} photos</p></header>
  <main>${PHOTOS.map(([title, from, to, glyph]) => `<figure><div class="pic" style="background: linear-gradient(160deg, ${from}, ${to})">${glyph}</div><figcaption>${title}</figcaption></figure>`).join("")}</main>
</body></html>`;

export async function startGallery(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
