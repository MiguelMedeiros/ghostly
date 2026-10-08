#!/usr/bin/env node
/**
 * The Chess the end-to-end tests run: e2e/fixtures/chess/index.html.txt, its one self-contained HTML file, with
 * e2e/fixtures/chess/chess.json saying where it came from. The e2e specs (e2e/support/chessFixture.ts) and the
 * store-keys test read this pinned copy instead of building Chess on the fly, so they keep working once Chess lives in
 * a repository of its own. It is kept as .txt so code scanning does not read the code it inlines (chess.js, minified)
 * as this repository's own.
 *
 *   node tools/scripts/refresh-chess-fixture.mjs                      build it from apps/mini/chess (today's source)
 *   node tools/scripts/refresh-chess-fixture.mjs --bundle <file|url>  take it from a signed Chess bundle
 *   node tools/scripts/refresh-chess-fixture.mjs --check              change nothing; exit 1 if the fixture is stale
 *
 * A bundle must be signed by Chess's publisher key (CHESS_PUBLISHER) and is read with the client's own reader
 * (readAppBundle: signature, file hashes). A URL must name one commit: raw.githubusercontent.com/<owner>/<repo>/<40-hex
 * commit>/... or cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex commit>/...; a branch or HEAD moves, so it is refused.
 *
 * Built from source, chess.json keeps the hash of the build's inputs (chessInputs), and
 * tools/scripts/test/chessFixture.test.ts fails while apps/mini/chess differs from what the fixture was built from.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
export const CHESS_SOURCE = "apps/mini/chess";
export const FIXTURE_DIR = "e2e/fixtures/chess";
/** The fixture's copy of Chess's entry (index.html in its bundle). */
export const FIXTURE_ENTRY = "index.html.txt";
/** Chess's publisher key in the official store (ghostly-store apps/chess.odcgw6wjw8dynqop). */
export const CHESS_PUBLISHER = "odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The files of apps/mini/chess the built index.html (and chess.json's version) comes from: not its tests. */
function inputFiles(dir) {
  const out = ["ghostly-app.json", "index.html", "package.json", "tsconfig.json", "vite.config.ts"].filter((f) => existsSync(join(dir, f)));
  const walk = (sub) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const path = `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  if (existsSync(join(dir, "src"))) walk("src");
  return out.sort();
}

/**
 * One SHA-256 over the build's inputs in apps/mini/chess (each file's path and its text with \n line ends), or null
 * when the folder is gone (Chess moved to its own repository).
 */
export function chessInputs(root = ROOT) {
  const dir = join(root, CHESS_SOURCE);
  if (!existsSync(join(dir, "vite.config.ts"))) return null;
  const hash = createHash("sha256");
  for (const file of inputFiles(dir)) {
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    hash.update(`${file}\0${Buffer.byteLength(text)}\0`).update(text);
  }
  return hash.digest("hex");
}

/** Whether `url` names one commit of a repository on GitHub's raw host or jsDelivr. */
export function isPinnedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  if (u.hostname === "raw.githubusercontent.com") return /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\/.+/.test(u.pathname);
  if (u.hostname === "cdn.jsdelivr.net") return /^\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\/.+/.test(u.pathname);
  return false;
}

/** Builds apps/mini/chess with its own Vite config: its one HTML file and chess.json. */
async function fromSource() {
  const { build } = await import("vite");
  const dir = join(ROOT, CHESS_SOURCE);
  if (!existsSync(join(dir, "vite.config.ts"))) throw new Error(`${CHESS_SOURCE} is not here: refresh from a signed bundle (--bundle)`);
  const out = mkdtempSync(join(tmpdir(), "chess-fixture-"));
  try {
    await build({ configFile: join(dir, "vite.config.ts"), root: dir, logLevel: "error", build: { outDir: out, emptyOutDir: true } });
    const html = readFileSync(join(out, "index.html"));
    const { name, version } = JSON.parse(readFileSync(join(dir, "ghostly-app.json"), "utf8"));
    return { html, meta: { name, version, from: { source: CHESS_SOURCE, inputs: chessInputs() } } };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Reads a signed Chess bundle (a file, or a URL pinned to a commit) and takes its entry out of it. `publisher`: the
 * key it must be signed by (another one only in this script's tests).
 */
export async function fromBundle(where, publisher = CHESS_PUBLISHER) {
  let bytes;
  if (/^https?:/i.test(where)) {
    if (!isPinnedUrl(where)) throw new Error(`${where} does not name one commit (raw.githubusercontent.com/<owner>/<repo>/<commit>/... or cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/...)`);
    const response = await fetch(where, { redirect: "error" });
    if (!response.ok) throw new Error(`${where}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = new Uint8Array(readFileSync(resolve(where)));
  }
  const { runnerImport } = await import("vite");
  const { module: core } = await runnerImport(join(ROOT, "packages/core/src/appBundle.ts"));
  const read = core.readAppBundle(bytes);
  if (!read.ok) throw new Error(`not a valid bundle: ${read.reason}${read.detail ? ` (${read.detail})` : ""}`);
  const { manifest, digest } = read.bundle;
  if (manifest.publisher !== publisher) throw new Error(`signed by ${manifest.publisher}, not Chess's publisher key ${publisher}`);
  if (manifest.name !== "chess") throw new Error(`the bundle is "${manifest.name}", not "chess"`);
  const html = read.bundle.files.get(manifest.entry);
  return {
    html: Buffer.from(html),
    meta: {
      name: manifest.name, version: manifest.version,
      from: { bundle: /^https?:/i.test(where) ? where : basename(where), ref: `${manifest.publisher}/${manifest.name}`, sequence: manifest.sequence, digest },
    },
  };
}

/** chess.json for `html`: what it is, where it came from, and its size and hash. */
function describe(html, meta) {
  return `${JSON.stringify({ ...meta, entry: "index.html", bytes: html.length, sha256: sha256(html) }, null, 2)}\n`;
}

async function main(args) {
  const at = args.indexOf("--bundle");
  const check = args.includes("--check");
  if (at >= 0 && !args[at + 1]) throw new Error("--bundle needs a file or a URL");
  const { html, meta } = at >= 0 ? await fromBundle(args[at + 1]) : await fromSource();
  const dir = join(ROOT, FIXTURE_DIR);
  const json = describe(html, meta);
  if (check) {
    const same = existsSync(join(dir, FIXTURE_ENTRY)) && readFileSync(join(dir, FIXTURE_ENTRY)).equals(html) && readFileSync(join(dir, "chess.json"), "utf8") === json;
    if (!same) {
      console.error(`${FIXTURE_DIR} is stale: run node tools/scripts/refresh-chess-fixture.mjs${at >= 0 ? ` --bundle ${args[at + 1]}` : ""}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${FIXTURE_DIR} is up to date (${meta.name} ${meta.version}, sha256 ${sha256(html).slice(0, 12)})`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FIXTURE_ENTRY), html);
  writeFileSync(join(dir, "chess.json"), json);
  console.log(`Wrote ${FIXTURE_DIR}: ${meta.name} ${meta.version}, ${html.length} bytes, sha256 ${sha256(html)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`refresh-chess-fixture: ${error.message}`);
    process.exitCode = 1;
  });
}
