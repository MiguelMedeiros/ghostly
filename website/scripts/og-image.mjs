#!/usr/bin/env node
/**
 * The share image (public/og-image.png, 1200x630): Boo and Casper, the name and the home page's headline on the
 * site's dark backdrop. Everything is read from the site's own sources, so the card follows them: the outline
 * (components/ghost/path.ts), the ghosts' colours (Ghost.tsx GHOST_COLORS), the eyes' ink (lib/motion.ts PAIR.eye),
 * the palette (app/site.css :root) and the headline (content/home.ts hero). The face is Ghost.tsx's "happy" mood.
 *
 * Rendered by Chromium through Playwright at 1200x630, deviceScaleFactor 1, then reduced to a 256-colour palette with
 * sharp (already in node_modules through Next). Inter comes from Google Fonts, as next/font fetches it for the site.
 *
 *   npm run og-image            write public/og-image.png
 *   npm run og-image -- --html  print the HTML instead (to look at it in a browser)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/og-image.png");
const W = 1200;
const H = 630;
const MAX_BYTES = 300 * 1024;

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

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&family=JetBrains+Mono:wght@500&display=block">
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
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
  .copy { position: absolute; left: 80px; top: 0; bottom: 0; width: 640px; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 40px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 44px; }
  .brand svg { width: 44px; height: 44px; color: ${BOO}; }
  h1 { font-size: 76px; line-height: 1.02; letter-spacing: -0.04em; font-weight: 700; }
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
  ${ghost({ id: "boo", fill: BOO, x: 748, y: 138, size: 190, tilt: 6, look: { x: 1, y: 0.2 } })}
  ${ghost({ id: "casper", fill: CASPER, x: 962, y: 190, size: 190, tilt: -6, look: { x: -1, y: -0.2 } })}
</body></html>`;

if (process.argv.includes("--html")) {
  process.stdout.write(html);
  process.exit(0);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // A fallback font would change every measure below: stop rather than write a card in the wrong face.
  const fonts = await page.evaluate(() => [document.fonts.check('700 76px "Inter"'), document.fonts.check('500 24px "JetBrains Mono"')]);
  if (!fonts.every(Boolean)) throw new Error("og-image: Inter or JetBrains Mono did not load (offline?)");

  // The layout holds: the words sit inside the card and clear of the ghosts.
  const boxes = await page.evaluate(() => {
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
  for (const w of boxes.words) {
    if (w.l < 0 || w.t < 0 || w.r > W || w.b > H) throw new Error(`og-image: "${w.text}" runs off the card`);
    if (w.r > firstGhost - 24) throw new Error(`og-image: "${w.text}" (right edge ${Math.round(w.r)}) runs into the ghosts (${firstGhost})`);
  }
  for (const g of boxes.ghosts) if (g.l < 0 || g.t < 0 || g.r > W || g.b > H) throw new Error(`og-image: ${g.id} runs off the card`);

  const shot = await page.screenshot({ type: "png" });
  const png = await sharp(shot).png({ palette: true, colours: 256, effort: 10, compressionLevel: 9 }).toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`og-image: rendered ${meta.width}x${meta.height}`);
  if (png.length >= MAX_BYTES) throw new Error(`og-image: ${png.length} bytes, over ${MAX_BYTES}`);
  writeFileSync(OUT, png);
  console.log(`og-image: wrote public/og-image.png, ${W}x${H}, ${(png.length / 1024).toFixed(1)} KB`);
  for (const w of boxes.words) console.log(`  "${w.text}" at x ${Math.round(w.l)}..${Math.round(w.r)}, y ${Math.round(w.t)}..${Math.round(w.b)}`);
  for (const g of boxes.ghosts) console.log(`  ${g.id} at x ${Math.round(g.l)}..${Math.round(g.r)}, y ${Math.round(g.t)}..${Math.round(g.b)}`);
} finally {
  await browser.close();
}
