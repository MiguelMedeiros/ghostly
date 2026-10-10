#!/usr/bin/env node
/**
 * The Chess the end-to-end tests run: e2e/fixtures/chess/index.html.txt, its one self-contained HTML file,
 * e2e/fixtures/chess/ghostly-app.json, the manifest it is published with, and e2e/fixtures/chess/chess.json saying
 * where both came from. Chess lives in a repository of its own (MiguelMedeiros/ghostly-chess), so the fixture is taken
 * from the bundle its publisher signed there and is never built here. The e2e specs (e2e/support/chessFixture.ts) read
 * this pinned copy. The page is kept as .txt so code scanning does not read the code it inlines (chess.js, minified)
 * as this repository's own.
 *
 *   node tools/scripts/refresh-chess-fixture.mjs --bundle <file|url>          take it from a signed Chess bundle
 *   node tools/scripts/refresh-chess-fixture.mjs --check                      change nothing; exit 1 if the fixture is
 *                                                                             not what the bundle chess.json names holds
 *   node tools/scripts/refresh-chess-fixture.mjs --check --bundle <file|url>  the same, against that bundle
 *
 * A bundle must be signed by Chess's publisher key (CHESS_PUBLISHER) and is read with the client's own reader
 * (readAppBundle: signature, file hashes). A URL must name one commit: raw.githubusercontent.com/<owner>/<repo>/<40-hex
 * commit>/... or cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex commit>/...; a branch or HEAD moves, so it is refused.
 *
 * --check fetches the bundle, so CI does not run it: tools/scripts/test/chessFixture.test.ts checks, with no network,
 * that the files are the ones chess.json describes. e2e/fixtures/chess/1.0.2 is the last Chess built in this
 * repository, kept as it was for the update test; this script leaves it alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
export const FIXTURE_DIR = "e2e/fixtures/chess";
/** The fixture's copy of Chess's entry (index.html in its bundle). */
export const FIXTURE_ENTRY = "index.html.txt";
/** The manifest Chess is published with (its ghostly-app.json). */
export const FIXTURE_MANIFEST = "ghostly-app.json";
/** Chess's publisher key in the official store (ghostly-store apps/chess.odcgw6wjw8dynqop). */
export const CHESS_PUBLISHER = "odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Whether `url` names one commit of a repository on GitHub's raw host or jsDelivr. */
export function isPinnedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  if (u.hostname === "raw.githubusercontent.com") return /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\/.+/.test(u.pathname);
  if (u.hostname === "cdn.jsdelivr.net") return /^\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\/.+/.test(u.pathname);
  return false;
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
  // The draft it was published from: the bundle's manifest without what the bundle's contents decide.
  const { ghostlyApp: _format, publisher: _key, files: _files, ...draft } = manifest;
  return {
    html: Buffer.from(html),
    manifest: `${JSON.stringify(draft, null, 2)}\n`,
    meta: {
      name: manifest.name, version: manifest.version,
      from: { bundle: /^https?:/i.test(where) ? where : basename(where), ref: `${manifest.publisher}/${manifest.name}`, sequence: manifest.sequence, digest },
    },
  };
}

/** chess.json for `html` and its manifest: what they are, where they came from, and their sizes and hashes. */
function describe(html, manifest, meta) {
  return `${JSON.stringify({ ...meta, entry: "index.html", bytes: html.length, sha256: sha256(html), manifestSha256: sha256(manifest) }, null, 2)}\n`;
}

async function main(args) {
  const at = args.indexOf("--bundle");
  const check = args.includes("--check");
  if (at >= 0 && !args[at + 1]) throw new Error("--bundle needs a file or a URL");
  const dir = join(ROOT, FIXTURE_DIR);
  // --check alone: against the bundle the fixture says it came from.
  const where = at >= 0 ? args[at + 1] : check ? JSON.parse(readFileSync(join(dir, "chess.json"), "utf8")).from?.bundle : undefined;
  if (!where) throw new Error("--bundle <file|url> is needed: Chess is not built in this repository");
  if (at < 0 && !/^https:/i.test(where)) throw new Error(`chess.json names a file (${where}): pass it with --bundle`);
  const { html, manifest, meta } = await fromBundle(where);
  const json = describe(html, manifest, meta);
  if (check) {
    const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : null);
    const same = read(FIXTURE_ENTRY)?.equals(html) && read(FIXTURE_MANIFEST)?.toString("utf8") === manifest && read("chess.json")?.toString("utf8") === json;
    if (!same) {
      console.error(`${FIXTURE_DIR} is not what ${where} holds: run node tools/scripts/refresh-chess-fixture.mjs --bundle ${where}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${FIXTURE_DIR} is what ${where} holds (${meta.name} ${meta.version}, sha256 ${sha256(html).slice(0, 12)})`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FIXTURE_ENTRY), html);
  writeFileSync(join(dir, FIXTURE_MANIFEST), manifest);
  writeFileSync(join(dir, "chess.json"), json);
  console.log(`Wrote ${FIXTURE_DIR}: ${meta.name} ${meta.version}, ${html.length} bytes, sha256 ${sha256(html)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`refresh-chess-fixture: ${error.message}`);
    process.exitCode = 1;
  });
}
