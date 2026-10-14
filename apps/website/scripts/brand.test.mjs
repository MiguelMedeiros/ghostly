// lib/brand/brand.json is the brand's one source: the /brand page and the press kit read it. These tests fail when the
// site, the lockup or the app say something else, and when a colour pair misses the contrast its use needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import brand from "../lib/brand/brand.json" with { type: "json" };
import { NEEDS, contrast, notations } from "../lib/brand/color.mjs";
import { KIT_DIR, SCREENSHOTS, kitEntries, logoFiles } from "../lib/brand/kit.mjs";
import { lockup, toSvg } from "../lib/brand/logo.mjs";
import { kitFiles, zip } from "./brand-kit.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SITE, "../..");
const read = (p) => readFileSync(join(SITE, p), "utf8");
const readRepo = (p) => readFileSync(join(REPO, p), "utf8");
const colors = [...brand.colors.core, ...brand.colors.extended];
const hexOf = (id) => colors.find((c) => c.id === id).hex;

/** The `--name: #hex;` declarations of the first block that `selector` opens in `css`. */
function block(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no ${selector} block`);
  const body = css.slice(at, css.indexOf("\n}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

test("the site's palette (app/site.css :root) is brand.json's, both ways", () => {
  const root = block(read("app/site.css"), ":root");
  // Aliases and scene colours, which take their values from the palette or the app's pictures, are left out.
  const palette = Object.fromEntries(Object.entries(root).filter(([k]) => !/^--(lvl|room|pair)-/.test(k)));
  const ours = Object.fromEntries(colors.filter((c) => c.site).map((c) => [c.site, c.hex]));
  assert.deepEqual(palette, ours);
});

test("the Tailwind theme (app/globals.css @theme) is brand.json's, both ways", () => {
  const theme = block(read("app/globals.css"), "@theme inline");
  const ours = Object.fromEntries(colors.filter((c) => c.theme).map((c) => [c.theme, c.hex]));
  assert.deepEqual(theme, ours);
});

test("the page background, the theme colour and the manifest are Night", () => {
  const night = hexOf("night");
  assert.match(read("app/layout.tsx"), new RegExp(`themeColor: "${night}"`));
  const manifest = JSON.parse(read("public/site.webmanifest"));
  assert.equal(manifest.background_color, night);
  assert.equal(manifest.theme_color, night);
});

test("the site's lockup, the app's lockup and the favicon draw brand.json's ghost", () => {
  const { iconPath, eyes, tile } = brand.logo;
  for (const [file, src] of [
    ["components/site/Brand.tsx", read("components/site/Brand.tsx")],
    ["apps/ui/src/components/AppBrand.tsx", readRepo("apps/ui/src/components/AppBrand.tsx")],
    ["public/favicon.svg", read("public/favicon.svg")],
  ]) {
    assert.ok(src.includes(`d="${iconPath}"`), `${file} draws another ghost`);
    assert.ok(src.includes('translate(12, 8)'), `${file} places the ghost elsewhere in its 64 box`);
    for (const e of eyes) assert.ok(src.includes(`cx="${e.cx}" cy="${e.cy}" r="${e.r}"`), `${file} has no eye at ${e.cx},${e.cy}`);
  }
  const favicon = read("public/favicon.svg");
  assert.ok(favicon.includes(`rx="${tile.radius}" fill="${tile.background}"`), "the favicon's tile");
  assert.ok(favicon.includes(`fill="${hexOf("cyan")}" opacity="${tile.ghostOpacity}"`), "the favicon's ghost");
  for (const h of tile.highlights) assert.ok(favicon.includes(`cx="${h.cx}" cy="${h.cy}" r="${h.r}"`), "the favicon's highlights");
  assert.match(read("app/site.css"), /\.brand \{[^}]*letter-spacing: -0\.025em;[^}]*text-transform: uppercase;/, "the site's wordmark setting");
});

test("Boo, Casper and the shade ghost are brand.json's colours", () => {
  const src = read("components/ghost/Ghost.tsx");
  for (const [who, id] of [["boo", "cyan"], ["casper", "mint"], ["shade", "slate"]]) assert.match(src, new RegExp(`${who}: "${hexOf(id)}"`, "i"), who);
});

test("the app's themes (apps/ui/src/index.css) are the ones the page shows", () => {
  const css = readRepo("apps/ui/src/index.css");
  const base = { dark: block(css, ":root,\n:root[data-theme=\"dark\"],\n:root[data-theme=\"dark\"][data-color-theme=\"classic\"]"), light: block(css, ":root[data-theme=\"light\"],\n:root[data-theme=\"light\"][data-color-theme=\"classic\"]") };
  for (const theme of brand.colors.app.themes) {
    const own = theme.id === "classic" ? {} : block(css, `:root[data-theme="${theme.mode}"][data-color-theme="${theme.id}"]`);
    for (const token of brand.colors.app.tokens) {
      const value = own[`--theme-${token}`] ?? base[theme.mode][`--theme-${token}`];
      assert.equal(theme.values[token], value, `${theme.name}: --theme-${token}`);
    }
  }
});

test("the type scale and the motion tokens are app/site.css's", () => {
  const css = read("app/site.css");
  for (const t of brand.type.scale) assert.ok(css.includes(`${t.token}: ${t.size};`), `${t.token}: ${t.size}`);
  for (const d of brand.motion.durations) assert.ok(css.includes(`${d.token}: ${d.ms / 1000}s;`), `${d.token}: ${d.ms / 1000}s`);
  for (const e of brand.motion.easings) assert.ok(css.includes(`${e.token}: cubic-bezier(${e.curve.join(", ")});`), e.token);
  assert.ok(css.includes(`--stagger: ${brand.motion.staggerMs / 1000}s;`), "--stagger");
});

test("every colour pair reads as its use needs, and the pair shown as a don't really fails", () => {
  for (const pair of brand.colors.contrast) {
    const ratio = contrast(pair.fg, pair.bg);
    if (pair.use === "avoid") assert.ok(ratio < NEEDS.graphic, `${pair.label} is shown as a failure but reads at ${ratio.toFixed(2)}`);
    else assert.ok(ratio >= NEEDS[pair.use], `${pair.label}: ${ratio.toFixed(2)}:1, ${pair.use} needs ${NEEDS[pair.use]}:1`);
  }
  // Each logo colourway on the background it is made for.
  for (const way of brand.logo.colorways) assert.ok(contrast(way.fill, way.on) >= NEEDS.graphic, `${way.name} logo on ${way.on}`);
});

test("the colour notations are right for known values", () => {
  assert.deepEqual(notations("#22d3ee"), { hex: "#22D3EE", rgb: "rgb(34 211 238)", hsl: "hsl(188 86% 53%)", oklch: "oklch(79.7% 0.134 211.5)" });
  assert.equal(notations("#ffffff").oklch, "oklch(100.0% 0.000 0.0)");
  assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
});

test("the core palette's shares add up to the whole", () => {
  assert.equal(brand.colors.core.reduce((n, c) => n + c.share, 0), 100);
});

test("the press contact is still to be set, and the kit says where to write meanwhile", () => {
  // When Miguel gives the address, set brand.press.contact and change this test.
  assert.equal(brand.press.contact, null);
  assert.match(kitEntries().find((e) => e.path === "boilerplate.txt").text, /Press: no address yet\. Until there is one, write through https:\/\/github\.com\//);
});

test("the kit holds every logo in every colourway, the colours, the fonts, the copy, the screenshots", () => {
  const paths = kitEntries().map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, "a path twice");
  for (const f of logoFiles()) for (const p of [f.svg, ...f.png.map((x) => x.path)]) assert.ok(paths.includes(p), p);
  assert.equal(logoFiles().length, 3 * brand.logo.colorways.length + 1);
  for (const p of ["README.txt", "boilerplate.txt", "fonts/FONTS.txt", "colors/ghostly-colors.ase", "colors/ghostly-colors.json", "colors/ghostly-colors.css", "social/ghostly-og-image.png"]) assert.ok(paths.includes(p), p);
  for (const s of SCREENSHOTS) assert.ok(paths.includes(`screenshots/ghostly-${s}.webp`), s);
  for (const e of kitEntries()) if (e.text) assert.doesNotMatch(e.text, /[\u2013\u2014]/, `${e.path} has a dash`);
});

test("the logo files are one path each, eyes cut out, in the colourway's colour", () => {
  const svg = toSvg(lockup("#22d3ee"), "Ghostly");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="2 4 /);
  assert.equal(svg.match(/<path /g).length, 2);
  assert.equal(svg.match(/fill="#22d3ee"/g).length, 2);
  assert.match(svg, /fill-rule="evenodd"/);
});

test("the .ase file is Adobe's format: header, groups and RGB swatches", () => {
  const ase = kitEntries().find((e) => e.path.endsWith(".ase")).bytes;
  assert.equal(ase.toString("ascii", 0, 4), "ASEF");
  assert.equal(ase.readUInt32BE(8), 2 * 2 + brand.colors.core.length + brand.colors.extended.length);
  assert.ok(ase.includes(Buffer.from("RGB ", "ascii")));
});

test("the zip reads back: every file, byte for byte", async () => {
  const files = (await kitFiles()).filter((f) => !f.path.startsWith("screenshots/")).slice(0, 12);
  const archive = zip(files.map((f) => ({ path: `${KIT_DIR}/${f.path}`, data: f.data })));
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 10), files.length);
  let at = archive.readUInt32LE(end + 16);
  for (const f of files) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLen = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    assert.equal(archive.toString("utf8", at + 46, at + 46 + nameLen), `${KIT_DIR}/${f.path}`);
    const dataAt = offset + 30 + archive.readUInt16LE(offset + 26);
    const body = archive.subarray(dataAt, dataAt + size);
    assert.deepEqual(method === 8 ? inflateRawSync(body) : body, f.data, f.path);
    at += 46 + nameLen;
  }
  // The same files give the same bytes.
  assert.deepEqual(zip(files.map((f) => ({ path: `${KIT_DIR}/${f.path}`, data: f.data }))), archive);
});
