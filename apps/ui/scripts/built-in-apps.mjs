#!/usr/bin/env node
/*
 * The bundles of the apps that come with Ghostly (WISP 1200 § Built-in apps) are not kept in this repository: each is
 * its publisher's signed file, read at a commit of the app's own repository and pinned by digest in
 * src/assets/apps/built-in.json (the same digest as the engine's list, `BUILT_IN_APPS`; a test holds the two equal).
 * This puts each one at src/assets/apps/<name>.ghostlyapp, which the build carries as a file of the client.
 *
 *   node apps/ui/scripts/built-in-apps.mjs           fetch what is missing or wrong; exit 1 if one could not be had
 *   node apps/ui/scripts/built-in-apps.mjs --check   no request: exit 1 if one is missing or wrong
 *   node apps/ui/scripts/built-in-apps.mjs --soft    as the first, but a failure only warns (the install hook: a
 *                                                    machine with no network still installs; the build asks again)
 *
 * A file whose digest is the pinned one is left alone, so a second run makes no request. The digest is the SHA-256 of
 * the bundle's manifest, which names every file's hash; the client checks the whole bundle when it reads it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "apps");
const MAGIC = Buffer.from("GHOSTLYAPP1");
const MAX_BYTES = 16 * 1024 * 1024;
const TRIES = 3;
const PINNED = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([\w.-]+)\/([\w.-]+)@([0-9a-f]{40})\/([\w./-]+)$/;

/** The digest of a bundle's bytes (base64url of the SHA-256 of its manifest), or null when they are not a bundle. */
export function bundleDigest(bytes) {
  if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const length = bytes.readUInt32BE(MAGIC.length);
  if (bytes.length < MAGIC.length + 4 + length) return null;
  return createHash("sha256").update(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + length)).digest("base64url");
}

/** Where a pinned jsDelivr URL's file also is: the same commit on raw.githubusercontent.com. Only pinned URLs are read. */
export function sourcesOf(url) {
  const m = PINNED.exec(url);
  if (!m) throw new Error(`not a jsDelivr URL pinned to a commit: ${url}`);
  return [url, `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`];
}

async function read(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`more than ${MAX_BYTES} bytes from ${new URL(url).host}`);
  return bytes;
}

const fileOf = (app) => join(DIR, `${app.name}.ghostlyapp`);
const held = (app) => existsSync(fileOf(app)) && bundleDigest(readFileSync(fileOf(app))) === app.digest;

async function fetchOne(app) {
  let last = null;
  for (const url of sourcesOf(app.url)) {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        const bytes = await read(url);
        const digest = bundleDigest(bytes);
        // The wrong bytes at a pinned commit do not get better: the next source, not the next try.
        if (digest !== app.digest) { last = new Error(`${new URL(url).host} holds ${digest ?? "something that is not a bundle"}, not ${app.digest}`); break; }
        mkdirSync(DIR, { recursive: true });
        writeFileSync(`${fileOf(app)}.part`, bytes);
        renameSync(`${fileOf(app)}.part`, fileOf(app));
        return;
      } catch (error) {
        last = error;
        if (attempt < TRIES) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  throw last ?? new Error("no source");
}

async function main(args) {
  const check = args.includes("--check");
  const soft = args.includes("--soft");
  const apps = JSON.parse(readFileSync(join(DIR, "built-in.json"), "utf8"));
  let failed = 0;
  for (const app of apps) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(app.name)) throw new Error(`built-in.json: not an app name: ${app.name}`);
    if (held(app)) continue;
    if (check) { console.error(`built-in apps: ${app.name} is missing or is not ${app.digest}. Run: npm run sync:apps`); failed++; continue; }
    try {
      await fetchOne(app);
      console.log(`built-in apps: ${app.name} ${app.digest} read from its repository`);
    } catch (error) {
      console.error(`built-in apps: ${app.name} could not be read (${error instanceof Error ? error.message : error})${soft ? "; the build will ask again" : ""}`);
      failed++;
    }
  }
  return failed && !soft ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
