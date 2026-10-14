// What the press kit holds, built from brand.json alone (the website's Docker image has no apps/ui). Pure: no file
// system, no sharp. scripts/brand-kit.mjs renders the PNGs and writes the files and the zip; the /brand page lists
// the same files and links to them; scripts/brand.test.mjs checks both.
import brand from "./brand.json" with { type: "json" };
import { notations } from "./color.mjs";
import { VARIANTS, draw, tile, toSvg } from "./logo.mjs";

/** The zip's name and the folder its files sit in, both under public/brand/ and inside the zip. */
export const KIT_ZIP = "ghostly-press-kit.zip";
export const KIT_DIR = "ghostly-press-kit";

/** PNG heights at 1x; 2x and 4x double them. */
export const PNG_HEIGHT = { lockup: 96, icon: 128, wordmark: 48, tile: 256 };
export const SCALES = [1, 2, 4];

const VARIANT_NAME = { lockup: "Logo", icon: "Icon", wordmark: "Wordmark", tile: "App icon" };

/** Every logo file: variant x colourway, plus the tile. Paths are relative to the kit's folder. */
export function logoFiles() {
  const files = [];
  for (const variant of VARIANTS) {
    for (const way of brand.logo.colorways) {
      const base = `ghostly-${variant}-${way.id}`;
      files.push({ variant, colorway: way.id, base, svg: `logo/svg/${base}.svg`, drawing: draw(variant, way.fill), title: `Ghostly ${VARIANT_NAME[variant].toLowerCase()}, ${way.name}` });
    }
  }
  files.push({ variant: "tile", colorway: "tile", base: "ghostly-tile", svg: "logo/svg/ghostly-tile.svg", drawing: tile(), title: "Ghostly app icon" });
  return files.map((f) => ({ ...f, png: SCALES.map((s) => ({ scale: s, height: PNG_HEIGHT[f.variant] * s, path: `logo/png/${f.base}@${s}x.png` })) }));
}

/** Screenshots copied from public/screenshots/current (the site's own, made by npm run capture). */
export const SCREENSHOTS = ["chat", "groups", "call", "file", "sats", "chat-mobile", "groups-mobile", "call-mobile", "sats-mobile"];

function colorRows(list) {
  return list.map((c) => ({ id: c.id, name: c.name, ...notations(c.hex), role: c.role }));
}

export function colorsJson() {
  const { core, extended, app } = brand.colors;
  return `${JSON.stringify({ name: "Ghostly colours", source: brand.url, core: colorRows(core), extended: colorRows(extended), appThemes: app.themes.map((t) => ({ name: t.name, values: t.values })) }, null, 2)}\n`;
}

export function colorsCss() {
  const rows = [...brand.colors.core, ...brand.colors.extended].map((c) => `  --ghostly-${c.id}: ${c.hex}; /* ${c.name}. ${c.role} */`);
  return `/* Ghostly colours. ${brand.url} */\n:root {\n${rows.join("\n")}\n}\n`;
}

/** Adobe Swatch Exchange: two groups (core, extended) of global RGB swatches. */
export function colorsAse() {
  const blocks = [];
  const name = (s) => {
    const b = Buffer.alloc(2 + (s.length + 1) * 2);
    b.writeUInt16BE(s.length + 1, 0);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
    return b;
  };
  const block = (type, body) => {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(type, 0);
    head.writeUInt32BE(body.length, 2);
    blocks.push(Buffer.concat([head, body]));
  };
  const group = (title, list) => {
    block(0xc001, name(title));
    for (const c of list) {
      const n = parseInt(c.hex.slice(1), 16);
      const body = Buffer.alloc(4 + 12 + 2);
      body.write("RGB ", 0, "ascii");
      body.writeFloatBE(((n >> 16) & 255) / 255, 4);
      body.writeFloatBE(((n >> 8) & 255) / 255, 8);
      body.writeFloatBE((n & 255) / 255, 12);
      body.writeUInt16BE(0, 16);
      block(0x0001, Buffer.concat([name(c.name), body]));
    }
    block(0xc002, Buffer.alloc(0));
  };
  group("Ghostly core", brand.colors.core);
  group("Ghostly extended", brand.colors.extended);
  const head = Buffer.alloc(12);
  head.write("ASEF", 0, "ascii");
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(0, 6);
  head.writeUInt32BE(blocks.length, 8);
  return Buffer.concat([head, ...blocks]);
}

const wrap = (text, width = 100) => {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join("\n");
};

export function contactLine() {
  return brand.press.contact ? `Press: ${brand.press.contact}` : `Press: no address yet. Until there is one, write through ${brand.press.contactFallback}`;
}

export function boilerplateTxt() {
  const f = brand.foundation;
  return [
    "Ghostly",
    "=======",
    "",
    `Tagline: ${f.tagline}`,
    "",
    "In one line",
    wrap(f.oneLine),
    "",
    "Short (about 40 words)",
    wrap(f.boilerplate.short),
    "",
    "Long (about 150 words)",
    wrap(f.boilerplate.long),
    "",
    "Writing the name",
    "Ghostly, with a capital G, one word. GHOSTLY in capitals is the logo, never a word in a sentence.",
    "",
    `Website: https://ghostly.tools  Source: ${brand.press.repo}  License: ${brand.press.license}`,
    contactLine(),
    `Brand guidelines: ${brand.url}`,
    "",
  ].join("\n");
}

export function fontsTxt() {
  const rows = brand.type.families
    .filter((f) => f.links.length)
    .map((f) => [`${f.name} (${f.license})`, `  ${f.role}`, `  Weights: ${f.weights.join(", ")}`, `  CSS: font-family: ${f.fallback};`, ...f.links.map((l) => `  ${l.href}`)].join("\n"));
  return [
    "Ghostly's fonts",
    "",
    "The fonts are free and open (SIL Open Font License). Download them from their makers; they are not copied here.",
    "",
    ...rows.flatMap((r) => [r, ""]),
    "The app itself uses the device's own font (system UI), and the wordmark is drawn as outlines in the logo files.",
    "",
  ].join("\n");
}

export function readmeTxt() {
  const logos = logoFiles();
  return [
    "Ghostly press kit",
    "=================",
    "",
    `The full guidelines, with every rule and example: ${brand.url}`,
    "",
    "What is here",
    `  logo/svg/     ${logos.length} vector files: the logo, the icon and the wordmark in four colours, and the app icon`,
    "  logo/png/     the same at 1x, 2x and 4x, transparent background (the app icon on its tile)",
    "  colors/       the palette as .ase (Adobe), .json and .css",
    "  fonts/        where to get Inter and JetBrains Mono",
    "  screenshots/  the app on a desktop and on a phone",
    "  social/       the share image, 1200 x 630",
    "  boilerplate.txt  the name, the tagline and the descriptions to quote",
    "",
    "The rules in short",
    "  - Ghost cyan on dark backgrounds, Night (navy) on light ones and on cyan. White or black only where those cannot work.",
    `  - Keep clear space of ${brand.logo.clearSpaceE} eye-widths around the logo. Smallest logo: ${brand.logo.minimum[0].px} px wide; below that, the icon.`,
    "  - Don't stretch, rotate, recolour, outline or add effects to the logo.",
    "  - Ghostly is open source (MIT), but the name and the logo say \"this is the Ghostly project\". Use them to talk about Ghostly, not to name your own product.",
    "",
    contactLine(),
    "",
  ].join("\n");
}

/** Every file of the kit, path relative to the kit's folder, with how to get its bytes. */
export function kitEntries() {
  const entries = [
    { path: "README.txt", text: readmeTxt() },
    { path: "boilerplate.txt", text: boilerplateTxt() },
    { path: "colors/ghostly-colors.ase", bytes: colorsAse() },
    { path: "colors/ghostly-colors.json", text: colorsJson() },
    { path: "colors/ghostly-colors.css", text: colorsCss() },
    { path: "fonts/FONTS.txt", text: fontsTxt() },
  ];
  for (const f of logoFiles()) {
    entries.push({ path: f.svg, text: toSvg(f.drawing, f.title) });
    for (const p of f.png) entries.push({ path: p.path, png: { svg: toSvg(f.drawing, f.title), height: p.height } });
  }
  for (const s of SCREENSHOTS) entries.push({ path: `screenshots/ghostly-${s}.webp`, copy: `public/screenshots/current/${s}.webp` });
  entries.push({ path: "social/ghostly-og-image.png", copy: "public/og-image.png" });
  return entries;
}
