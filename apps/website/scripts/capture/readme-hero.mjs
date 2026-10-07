#!/usr/bin/env node
// node apps/website/scripts/capture/readme-hero.mjs <shots folder>: the README's hero from readme.spec.ts's shots
// (x-readme-desktop.png, x-readme-phone.png), written to docs/assets/readme/hero.webp: the desktop app with the
// phone in front of its right side, 1600 wide (the README shows it at 720). Transparent around the frames, so it
// sits on GitHub's light or dark page.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const sharp = createRequire(join(REPO, "apps/website/package.json"))("sharp");
const shots = process.argv[2];
if (!shots) throw new Error("usage: readme-hero.mjs <folder with x-readme-desktop.png and x-readme-phone.png>");
const OUT = join(REPO, "docs/assets/readme");
const BORDER = "#30363d";
const clear = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
const webp = { quality: 80, effort: 6, alphaQuality: 90 };

/** An image resized to w × h with round corners and a thin edge. */
async function rounded(input, w, h, r) {
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`);
  const edge = Buffer.from(`<svg width="${w}" height="${h}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r - 1}" fill="none" stroke="${BORDER}" stroke-width="2"/></svg>`);
  const img = await sharp(input).resize(w, h).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return sharp(img).composite([{ input: edge }]).png().toBuffer();
}

/** A soft shadow for a w × h frame, `blur` * 2 larger on each side. */
const shadow = (w, h, r, blur, alpha) => sharp(Buffer.from(
  `<svg width="${w + blur * 4}" height="${h + blur * 4}"><rect x="${blur * 2}" y="${blur * 2}" width="${w}" height="${h}" rx="${r}" fill="rgba(0,0,0,${alpha})"/></svg>`,
)).blur(blur).png().toBuffer();

/** The phone shot in a dark bezel, w wide. */
async function phone(file, w) {
  const screen = await sharp(file).png().toBuffer();
  const meta = await sharp(screen).metadata();
  const sw = w - 28, sh = Math.round(meta.height * sw / meta.width);
  const bezel = Buffer.from(`<svg width="${w}" height="${sh + 28}"><rect width="${w}" height="${sh + 28}" rx="50" fill="#0b0f14"/><rect x="1.5" y="1.5" width="${w - 3}" height="${sh + 25}" rx="48.5" fill="none" stroke="${BORDER}" stroke-width="3"/></svg>`);
  const inner = await sharp(screen).resize(sw, sh).composite([{ input: Buffer.from(`<svg width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="36" fill="#fff"/></svg>`), blend: "dest-in" }]).png().toBuffer();
  return { buf: await sharp(bezel).composite([{ input: inner, left: 14, top: 14 }]).png().toBuffer(), w, h: sh + 28 };
}

const desktopShot = join(shots, "x-readme-desktop.png");
const phoneShot = join(shots, "x-readme-phone.png");

const W = 1600, H = 1060, dw = 1320;
const { width: sw0, height: sh0 } = await sharp(desktopShot).metadata();
const dh = Math.round(sh0 * dw / sw0);
const ph = await phone(phoneShot, 470);
await clear(W, H).composite([
  { input: await shadow(dw, dh, 22, 14, 0.18), left: 2, top: 12 },
  { input: await rounded(desktopShot, dw, dh, 22), left: 30, top: 40 },
  { input: await shadow(ph.w, ph.h, 50, 16, 0.3), left: W - ph.w - 62, top: H - ph.h - 52 },
  { input: ph.buf, left: W - ph.w - 30, top: H - ph.h - 20 },
]).webp(webp).toFile(join(OUT, "hero.webp"));

console.log(`wrote ${join(OUT, "hero.webp")}`);
