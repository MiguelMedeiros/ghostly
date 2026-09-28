#!/usr/bin/env node
/**
 * The share image (public/og-image.png, 1200x630) and the repository's social preview (docs/assets/social-preview.png,
 * 1280x640, uploaded by hand in GitHub's Settings, Social preview): Boo and Casper, the name and the home page's
 * headline on the site's dark backdrop, laid out for each size. Everything is read from the site's own sources, so
 * the cards follow them: the outline
 * (components/ghost/path.ts), the ghosts' colours (Ghost.tsx GHOST_COLORS), the eyes' ink (lib/motion.ts PAIR.eye),
 * the palette (app/site.css :root) and the headline (content/home.ts hero). The face is Ghost.tsx's "happy" mood.
 *
 * Rendered by Chromium through Playwright at each card's size, deviceScaleFactor 1, then reduced to a 256-colour
 * palette with sharp (already in node_modules through Next). Inter comes from Google Fonts, as next/font fetches it
 * for the site. Words and ghosts keep 40px from every edge (GitHub crops the social preview's edges in places).
 *
 *   npm run og-image                   write both cards
 *   npm run og-image -- --html og      print a card's HTML instead (og or social; to look at it in a browser)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE = 40;
/** Each card: its size, file, byte limit, and where the copy and the two ghosts sit. */
const CARDS = {
  og: {
    w: 1200, h: 630, out: "public/og-image.png", maxBytes: 300 * 1024,
    left: 80, brand: 40, title: 76,
    boo: { x: 748, y: 138, size: 190 }, casper: { x: 962, y: 190, size: 190 },
  },
  social: {
    w: 1280, h: 640, out: "../docs/assets/social-preview.png", maxBytes: 1024 * 1024,
    left: 96, brand: 42, title: 80,
    boo: { x: 804, y: 128, size: 200 }, casper: { x: 1028, y: 184, size: 200 },
  },
};

const read = (p) => readFileSync(join(ROOT, p), "utf8");
function pick(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`og-image: could not find ${what}`);
  return m[1];
}

const GHOST_PATH = pick(read("components/ghost/path.ts"), /GHOST_PATH = "([^"]+)"/, "GHOST_PATH in components/ghost/path.ts");
const ghostSrc = read("components/ghost/Ghost.tsx");
const colors = pick(ghostSrc, /GHOST_COLORS = \{([^}]+)\}/, "GHOST_COLORS in Ghost.tsx");
const BOO = pick(colors, /boo: "(#[0-9a-f]{6})"/i, "GHOST_COLORS.boo");
const CASPER = pick(colors, /casper: "(#[0-9a-f]{6})"/i, "GHOST_COLORS.casper");
const INK = pick(read("lib/motion.ts"), /PAIR = \{[^}]*?eye: "(#[0-9a-f]{6})"/i, "PAIR.eye in lib/motion.ts");
const css = read("app/site.css");
const v = (name) => pick(css, new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"), `--${name} in app/site.css`);
const home = read("content/home.ts");
const TITLE1 = pick(home, /title1: "([^"]+)"/, "hero.title1 in content/home.ts");
const TITLE2 = pick(home, /title2: "([^"]+)"/, "hero.title2 in content/home.ts");

/** One ghost as Ghost.tsx draws it in the "happy" mood: body, sheen, eyes, pupils looking `look`, smile, cheeks. */
function ghost({ id, fill, x, y, size, tilt = 0, look = { x: 0, y: 0 } }) {
  const px = (look.x * 2.2).toFixed(2);
  const py = (look.y * 1.8).toFixed(2);
  return `
  <svg class="ghost" data-ghost="${id}" viewBox="0 0 80 100" width="${size}" height="${size * 1.25}" style="left:${x}px;top:${y}px">
    <defs>
      <radialGradient id="sheen-${id}" cx="35%" cy="25%" r="75%">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.2" />
        <stop offset="45%" stop-color="#fff" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#000" stop-opacity="0.1" />
      </radialGradient>
      <radialGradient id="halo-${id}" cx="50%" cy="45%" r="50%">
        <stop offset="0%" stop-color="${fill}" stop-opacity="0.42" />
        <stop offset="100%" stop-color="${fill}" stop-opacity="0" />
      </radialGradient>
    </defs>
    <ellipse cx="40" cy="46" rx="56" ry="60" fill="url(#halo-${id})" />
    <g transform="rotate(${tilt} 40 72)">
      <path d="${GHOST_PATH}" fill="${fill}" />
      <path d="${GHOST_PATH}" fill="url(#sheen-${id})" />
      <ellipse cx="29" cy="36" rx="6" ry="6.5" fill="${INK}" />
      <ellipse cx="51" cy="36" rx="6" ry="6.5" fill="${INK}" />
      <g transform="translate(${px} ${py})">
        <circle cx="30.5" cy="34" r="2" fill="#fff" />
        <circle cx="52.5" cy="34" r="2" fill="#fff" />
      </g>
      <path d="M33 50 Q40 57 47 50" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" />
      <g opacity="0.35" fill="#f472b6">
        <ellipse cx="21" cy="46" rx="4" ry="2.2" />
        <ellipse cx="59" cy="46" rx="4" ry="2.2" />
      </g>
    </g>
  </svg>`;
}

const page = (c) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&family=JetBrains+Mono:wght@500&display=block">
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${c.w}px; height: ${c.h}px; overflow: hidden; }
  body { position: relative; background: ${v("bg")}; color: ${v("text")}; font-family: Inter, system-ui, sans-serif; }
  /* The hero's backdrop (app/home.css .hero-light, .hero-bg), scaled to the card. */
  .light { position: absolute; inset: 0; background:
    radial-gradient(520px 520px at 22% 40%, rgba(34, 211, 238, 0.09), transparent 70%),
    radial-gradient(640px 640px at 76% 55%, rgba(0, 168, 132, 0.09), transparent 70%); }
  .grid { position: absolute; inset: 0; opacity: 0.7;
    background-image: linear-gradient(rgba(34, 211, 238, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34, 211, 238, 0.05) 1px, transparent 1px);
    background-size: 60px 60px;
    -webkit-mask-image: radial-gradient(ellipse at 40% 45%, #000 20%, transparent 70%); }
  .copy { position: absolute; left: ${c.left}px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: ${c.brand}px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 44px; }
  .brand svg { width: ${c.brand + 4}px; height: ${c.brand + 4}px; color: ${BOO}; }
  h1 { font-size: ${c.title}px; line-height: 1.02; letter-spacing: -0.04em; font-weight: 700; }
  h1 span { display: block; white-space: nowrap; }
  h1 .accent { color: ${v("cyan")}; }
  .url { margin-top: 48px; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 24px; font-weight: 500; color: ${v("muted")}; }
  .ghost { position: absolute; overflow: visible; }
</style></head>
<body>
  <div class="light"></div>
  <div class="grid"></div>
  <div class="copy">
    <div class="brand" id="brand">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/><circle cx="9" cy="9" r="1.5" fill="${v("bg")}"/><circle cx="15" cy="9" r="1.5" fill="${v("bg")}"/></svg>
      <span>Ghostly</span>
    </div>
    <h1 id="title"><span>${TITLE1}</span><span class="accent">${TITLE2}</span></h1>
    <p class="url" id="url">ghostly.tools</p>
  </div>
  ${ghost({ id: "boo", fill: BOO, ...c.boo, tilt: 6, look: { x: 1, y: 0.2 } })}
  ${ghost({ id: "casper", fill: CASPER, ...c.casper, tilt: -6, look: { x: -1, y: -0.2 } })}
</body></html>`;

const htmlFlag = process.argv.indexOf("--html");
if (htmlFlag !== -1) {
  process.stdout.write(page(CARDS[process.argv[htmlFlag + 1] ?? "og"]));
  process.exit(0);
}

const browser = await chromium.launch();
try {
  for (const c of Object.values(CARDS)) await render(c);
} finally {
  await browser.close();
}

async function render(c) {
  const { w: W, h: H } = c;
  const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await tab.setContent(page(c), { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  // A fallback font would change every measure below: stop rather than write a card in the wrong face.
  const fonts = await tab.evaluate(() => [document.fonts.check('700 76px "Inter"'), document.fonts.check('500 24px "JetBrains Mono"')]);
  if (!fonts.every(Boolean)) throw new Error("og-image: Inter or JetBrains Mono did not load (offline?)");

  // The layout holds: the words and the ghosts keep clear of the edges, and the words clear of the ghosts.
  const boxes = await tab.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    const words = [...document.querySelectorAll("#brand, #title span, #url")].map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { text: el.textContent.trim(), ...box(range) };
    });
    return { words, ghosts: [...document.querySelectorAll("[data-ghost]")].map((el) => ({ id: el.dataset.ghost, ...box(el) })) };
  });
  const firstGhost = Math.min(...boxes.ghosts.map((g) => g.l));
  const outside = (b) => b.l < SAFE || b.t < SAFE || b.r > W - SAFE || b.b > H - SAFE;
  for (const w of boxes.words) {
    if (outside(w)) throw new Error(`og-image: "${w.text}" leaves the ${SAFE}px safe area of ${c.out}`);
    if (w.r > firstGhost - 24) throw new Error(`og-image: "${w.text}" (right edge ${Math.round(w.r)}) runs into the ghosts (${firstGhost})`);
  }
  for (const g of boxes.ghosts) if (outside(g)) throw new Error(`og-image: ${g.id} leaves the ${SAFE}px safe area of ${c.out}`);

  const shot = await tab.screenshot({ type: "png" });
  await tab.close();
  const png = await sharp(shot).png({ palette: true, colours: 256, effort: 10, compressionLevel: 9 }).toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`og-image: rendered ${meta.width}x${meta.height}`);
  if (png.length >= c.maxBytes) throw new Error(`og-image: ${c.out} is ${png.length} bytes, over ${c.maxBytes}`);
  writeFileSync(join(ROOT, c.out), png);
  console.log(`og-image: wrote ${c.out}, ${W}x${H}, ${(png.length / 1024).toFixed(1)} KB`);
  for (const w of boxes.words) console.log(`  "${w.text}" at x ${Math.round(w.l)}..${Math.round(w.r)}, y ${Math.round(w.t)}..${Math.round(w.b)}`);
  for (const g of boxes.ghosts) console.log(`  ${g.id} at x ${Math.round(g.l)}..${Math.round(g.r)}, y ${Math.round(g.t)}..${Math.round(g.b)}`);
}
